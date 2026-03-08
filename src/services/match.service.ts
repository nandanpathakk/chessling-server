import { supabase } from '../supabase'
import { sendPrize, sendDrawRefunds, sendRefund, verifyStakeTransaction } from './prize.service'

export interface MatchRow {
  id: string
  code: string
  status: string
  stake_amount: number
  time_control: number
  host_public_key: string
  host_color: string
  host_staked: boolean
  host_tx: string | null
  guest_public_key: string | null
  guest_color: string | null
  guest_staked: boolean
  guest_tx: string | null
  fen: string
  pgn: string
  moves: string[]
  turn: string
  last_move_from: string | null
  last_move_to: string | null
  move_count: number
  clock_white: number
  clock_black: number
  clock_last_updated: number
  clock_last_turn: string | null
  winner: string | null
  result_reason: string | null
  prize_amount: number | null
  prize_tx: string | null
  created_at: string
  started_at: string | null
  ended_at: string | null
}

// ── ID/code helpers ───────────────────────────────────────────────────────────

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10)
}

function generateCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('')
}

// ── Winner resolution ─────────────────────────────────────────────────────────

/**
 * Returns the public key of the winning player, or null for draws/no-winner.
 * This is the single source of truth for winner-to-address mapping.
 */
export function resolveWinnerAddress(match: MatchRow): string | null {
  if (!match.winner || match.winner === 'draw') return null
  if (match.winner === match.host_color) return match.host_public_key
  if (match.winner === match.guest_color) return match.guest_public_key ?? null
  return null
}

// ── Atomic disburse slot (race-condition prevention) ─────────────────────────

/**
 * Atomically marks the match's prize as "pending disbursement" by setting
 * prize_tx = 'pending'. Returns true if this process claimed the slot
 * (prize_tx was null and match is completed), false if another process
 * already claimed it.
 *
 * This prevents double-payment: only one caller can win this race.
 */
async function claimDisburseSlot(matchId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('matches')
    .update({ prize_tx: 'pending' })
    .eq('id', matchId)
    .eq('status', 'completed')
    .is('prize_tx', null)
    .select('id')

  if (error) return false
  return Array.isArray(data) && data.length > 0
}

/**
 * Resets prize_tx from 'pending' back to null when disbursement fails.
 * Allows a subsequent attempt (auto-retry or manual /claim) to succeed.
 */
async function releaseDisburseSlot(matchId: string): Promise<void> {
  await supabase
    .from('matches')
    .update({ prize_tx: null })
    .eq('id', matchId)
    .eq('prize_tx', 'pending')
}

// ── Auto-disburse ─────────────────────────────────────────────────────────────

/**
 * Immediately distributes prize/refunds when a match completes.
 * - Winner: gets total pot minus 5% fee.
 * - Draw:   each player gets their stake minus their share of the fee.
 *
 * Uses an atomic slot claim so only one process ever disburses.
 * On failure the slot is released so the /claim fallback can retry.
 *
 * Always called fire-and-forget (errors are logged, not thrown).
 */
export async function autoDisburse(matchId: string): Promise<void> {
  // Step 1: atomically claim the disbursement slot
  const claimed = await claimDisburseSlot(matchId)
  if (!claimed) {
    // Either already disbursed, or match not yet completed — nothing to do
    console.log(`[disburse] Match ${matchId}: slot not available, skipping`)
    return
  }

  try {
    // Re-fetch the full match now that we own the slot
    const match = await getMatch(matchId)

    const prizeAmount = match.prize_amount ?? 0
    if (prizeAmount <= 0) {
      // No prize (e.g. abandoned with nothing staked) — clear pending marker
      await releaseDisburseSlot(matchId)
      return
    }

    let prizeTx: string

    if (match.winner === 'draw') {
      if (!match.guest_public_key && prizeAmount > 0) throw new Error('Draw but guest address is missing')
      const { hostTx, guestTx } = await sendDrawRefunds(
        match.host_public_key,
        match.guest_public_key ?? match.host_public_key,
        prizeAmount,
      )
      prizeTx = `host:${hostTx};guest:${guestTx}`
    } else {
      const winnerAddress = resolveWinnerAddress(match)
      if (!winnerAddress) throw new Error(`Cannot resolve winner address (winner=${match.winner})`)
      prizeTx = await sendPrize(winnerAddress, prizeAmount)
    }

    // Record the real tx signature (replaces 'pending')
    await recordPrizeTx(matchId, prizeTx)
    console.log(`[disburse] Match ${matchId}: disbursed | prize_tx: ${prizeTx}`)
  } catch (err) {
    console.error(`[disburse] Match ${matchId}: failed —`, err)
    // Release the slot so the /claim fallback endpoint can retry
    await releaseDisburseSlot(matchId)
  }
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

import { randomBytes } from 'crypto'

export async function createLocalPlayMatch(publicKey: string): Promise<MatchRow> {
  const code = randomBytes(3).toString('hex').toUpperCase()
  const id = generateId()

  const { data, error } = await supabase
    .from('matches')
    .insert({
      id,
      code,
      host_public_key: publicKey,
      guest_public_key: publicKey,
      stake_amount: 0,
      time_control: 600, // 10 minutes default for dev testing
      host_color: 'white',
      guest_color: 'black',
      host_staked: true,   // Auto stake
      guest_staked: true,  // Auto stake
      host_tx: `local-${Date.now()}-h`,
      guest_tx: `local-${Date.now()}-g`,
      status: 'active',    // Go straight into game
      fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      pgn: '',
      moves: [],
      turn: 'w',
      clock_white: 600 * 1000,
      clock_black: 600 * 1000,
      clock_last_updated: Date.now(),
      started_at: new Date().toISOString(),
    })
    .select('*')
    .single()

  if (error) throw new Error(`Failed to create local match: ${error.message}`)
  return data as MatchRow
}

export async function createMatch(
  hostPublicKey: string,
  stakeAmount: number,
  timeControl: number,
): Promise<{ matchId: string; code: string }> {
  const { Chess } = await import('chess.js')
  const game = new Chess()
  const id = generateId()
  const code = generateCode()
  const timeMs = timeControl * 1000
  const hostColor = Math.random() > 0.5 ? 'white' : 'black'

  const { error } = await supabase.from('matches').insert({
    id,
    code,
    status: 'waiting',
    stake_amount: stakeAmount,
    time_control: timeControl,
    host_public_key: hostPublicKey,
    host_color: hostColor,
    host_staked: false,
    guest_staked: false,
    fen: game.fen(),
    pgn: '',
    moves: [],
    turn: 'w',
    move_count: 0,
    clock_white: timeMs,
    clock_black: timeMs,
    clock_last_updated: Date.now(),
    clock_last_turn: null,
  })

  if (error) throw new Error(error.message)
  return { matchId: id, code }
}

export async function getMatchByCode(code: string): Promise<MatchRow> {
  const { data, error } = await supabase
    .from('matches')
    .select('*')
    .eq('code', code.toUpperCase())
    .single()

  if (error || !data) throw new Error('Match not found')
  return data as MatchRow
}

export async function getMatch(matchId: string): Promise<MatchRow> {
  const { data, error } = await supabase
    .from('matches')
    .select('*')
    .eq('id', matchId)
    .single()

  if (error || !data) throw new Error('Match not found')
  return data as MatchRow
}

/**
 * Fetches a match and, if it is active with an expired clock, auto-completes
 * it via timeout before returning the updated state.
 *
 * This is the "lazy" server-side timeout detector (P1).
 * It guarantees that any route handler or service function that calls this
 * will always receive the true current state — even when both clients are
 * offline and nobody called POST /timeout.
 *
 * Use this everywhere instead of getMatch() when the caller cares about
 * whether the game is still running.
 */
export async function getMatchResolved(matchId: string): Promise<MatchRow> {
  const match = await getMatch(matchId)
  if (match.status !== 'active') return match

  const elapsed = Date.now() - match.clock_last_updated
  const currentTurnColor = match.turn === 'w' ? 'white' : 'black'
  const currentClock =
    currentTurnColor === 'white' ? match.clock_white : match.clock_black

  if (currentClock - elapsed <= 0) {
    try {
      // flagTimeout validates and writes the result atomically
      await flagTimeout(matchId, currentTurnColor)
    } catch {
      // Already completed by a concurrent request — fine, just re-fetch
    }
    return getMatch(matchId) // return the now-completed state
  }

  return match
}

export async function joinMatch(matchId: string, guestPublicKey: string): Promise<void> {
  const match = await getMatch(matchId)

  if (match.status !== 'waiting') throw new Error('Match is not open')
  if (match.host_public_key === guestPublicKey) throw new Error('Cannot join your own match')

  const guestColor = match.host_color === 'white' ? 'black' : 'white'

  const { error } = await supabase
    .from('matches')
    .update({ guest_public_key: guestPublicKey, guest_color: guestColor, status: 'staking' })
    .eq('id', matchId)

  if (error) throw new Error(error.message)
}

export async function confirmStake(
  matchId: string,
  publicKey: string,
  txSignature: string,
): Promise<{ bothStaked: boolean }> {
  const match = await getMatch(matchId)

  const isHost = match.host_public_key === publicKey
  const isGuest = match.guest_public_key === publicKey
  if (!isHost && !isGuest) throw new Error('Not a participant')

  // Prevent replay attacks: txSignature must not be used already
  const { data: existingTx, error: txError } = await supabase
    .from('matches')
    .select('id')
    .or(`host_tx.eq.${txSignature},guest_tx.eq.${txSignature}`)
    .limit(1)

  if (txError) throw new Error(txError.message)
  if (existingTx && existingTx.length > 0) {
    throw new Error('Transaction signature already used')
  }

  // Verify transaction on-chain (throws if invalid)
  if (match.stake_amount > 0) {
    await verifyStakeTransaction(txSignature, match.stake_amount, publicKey)
  }

  const updates: Record<string, unknown> = isHost
    ? { host_staked: true, host_tx: txSignature }
    : { guest_staked: true, guest_tx: txSignature }

  const hostStaked = isHost ? true : match.host_staked
  const guestStaked = isGuest ? true : match.guest_staked

  if (hostStaked && guestStaked) {
    updates.status = 'active'
    updates.started_at = new Date().toISOString()
    updates.clock_last_updated = Date.now()
  }

  const { error } = await supabase.from('matches').update(updates).eq('id', matchId)
  if (error) throw new Error(error.message)

  return { bothStaked: hostStaked && guestStaked }
}

export async function applyMove(
  matchId: string,
  publicKey: string,
  from: string,
  to: string,
  // newClockMs is accepted for API compatibility but is NOT used for server
  // clock computation — the server derives clock from clock_last_updated to
  // prevent clients from inflating their remaining time (P0 security fix).
  _newClockMs: number,
): Promise<void> {
  const { Chess } = await import('chess.js')

  // Use getMatchResolved so an expired clock is auto-completed before the
  // move is validated (P1 lazy check). If the clock expired, this returns a
  // completed match and the status check below will reject the move.
  const match = await getMatchResolved(matchId)

  if (match.status !== 'active') throw new Error('Game is not active')

  const isHost = match.host_public_key === publicKey
  const isGuest = match.guest_public_key === publicKey
  if (!isHost && !isGuest) throw new Error('Not a participant')

  const isLocalPlay = match.host_public_key === match.guest_public_key

  // If local play, the "playerColor" dynamically matches whose turn it is
  const playerColor = isLocalPlay
    ? (match.turn === 'w' ? 'white' : 'black')
    : (isHost ? match.host_color : match.guest_color)

  const chessColor = playerColor === 'white' ? 'w' : 'b'

  if (!isLocalPlay && match.turn !== chessColor) {
    throw new Error('Not your turn')
  }

  // ── P0: Server-computed clock ────────────────────────────────────────────
  // Compute how much time this player has left based on server timestamps.
  // We never trust newClockMs from the client — a cheating player could send
  // an inflated value to prevent their own clock from ever reaching zero.
  const elapsed = Date.now() - match.clock_last_updated
  const priorClock = playerColor === 'white' ? match.clock_white : match.clock_black
  const serverClock = priorClock - elapsed

  // If the clock ran out before this move reached the server (beyond a small
  // grace period for network jitter), complete the match as a timeout instead.
  // This path is rarely hit because getMatchResolved already catches expired
  // clocks; it handles the narrow race window between the two DB reads.
  const MOVE_SUBMISSION_GRACE_MS = 3_000
  if (serverClock < -MOVE_SUBMISSION_GRACE_MS) {
    // Complete as timeout — player ran out of time
    await flagTimeout(matchId, playerColor!).catch(() => {
      // Another concurrent request may have already completed it — ignore
    })
    throw new Error('Your clock ran out — game over by timeout')
  }

  const trustedClock = Math.max(0, serverClock)
  // ──────────────────────────────────────────────────────────────────────────

  // chess.js validates the move — throws if invalid
  const game = new Chess(match.fen)
  console.log('[DEBUG makeMove]', { from, to, fen: match.fen, color: playerColor, turn: match.turn })

  let result;
  try {
    result = game.move({ from, to, promotion: 'q' })
  } catch (err: any) {
    console.error('[DEBUG makeMove error]', err.message)
    throw err
  }

  if (!result) throw new Error('Invalid move')

  const newMoves = [...match.moves, `${from}${to}`]
  const isGameOver = game.isGameOver()

  const updates: Record<string, unknown> = {
    fen: game.fen(),
    pgn: game.pgn(),
    moves: newMoves,
    turn: game.turn(),
    last_move_from: from,
    last_move_to: to,
    move_count: match.move_count + 1,
    clock_last_updated: Date.now(),
    clock_last_turn: chessColor,
    // Store server-computed clock, not the client-provided value
    ...(playerColor === 'white' ? { clock_white: trustedClock } : { clock_black: trustedClock }),
  }

  if (isGameOver) {
    let winner: string
    let reason: string

    if (game.isCheckmate()) {
      // The player who just moved (chessColor) caused checkmate — they win
      winner = playerColor! // 'white' or 'black'
      reason = 'checkmate'
    } else {
      // All other game-over states are draws
      winner = 'draw'
      reason = game.isStalemate() ? 'stalemate' : 'draw'
    }

    updates.status = 'completed'
    updates.ended_at = new Date().toISOString()
    updates.winner = winner
    updates.result_reason = reason
    // Always store the full pot so the disbursement logic knows how much to send
    updates.prize_amount = match.stake_amount * 2
  }

  // Optimistic lock: only apply the move if the match is still active.
  // Prevents applying a move to a match that was simultaneously ended by timeout.
  const { data: updated, error } = await supabase
    .from('matches')
    .update(updates)
    .eq('id', matchId)
    .eq('status', 'active')
    .select('id')

  if (error) throw new Error(error.message)
  if (!updated || updated.length === 0) throw new Error('Move rejected: game is no longer active')

  // Fire-and-forget auto-disbursement when the game ends
  if (isGameOver) {
    autoDisburse(matchId).catch(console.error)
  }
}

export async function resignMatch(matchId: string, publicKey: string): Promise<void> {
  // Resolve clocks first: if the opponent already ran out of time, the timeout
  // result takes precedence and the resignation is rejected as "not active".
  const match = await getMatchResolved(matchId)
  if (match.status !== 'active') throw new Error('Game is not active')

  const isHost = match.host_public_key === publicKey
  const isGuest = match.guest_public_key === publicKey
  if (!isHost && !isGuest) throw new Error('Not a participant')

  const loserColor = isHost ? match.host_color : match.guest_color
  const winner = loserColor === 'white' ? 'black' : 'white'

  // Optimistic lock: only resign if still active
  const { data: updated, error } = await supabase
    .from('matches')
    .update({
      status: 'completed',
      ended_at: new Date().toISOString(),
      winner,
      result_reason: 'resignation',
      prize_amount: match.stake_amount * 2,
    })
    .eq('id', matchId)
    .eq('status', 'active')
    .select('id')

  if (error) throw new Error(error.message)
  if (!updated || updated.length === 0) throw new Error('Game is no longer active')

  autoDisburse(matchId).catch(console.error)
}

/**
 * Server-side timeout handling.
 *
 * Security: the server independently verifies the clock has actually expired
 * (with a 5-second grace period for network latency) and that the flagged
 * color matches the current turn. This prevents clients from falsely
 * flagging opponents.
 */
export async function flagTimeout(matchId: string, timedOutColor: string): Promise<void> {
  const match = await getMatch(matchId)

  // Silently ignore if already ended (idempotent)
  if (match.status !== 'active') return

  // ── Clock verification ──────────────────────────────────────────────────────

  const currentTurnColor = match.turn === 'w' ? 'white' : 'black'

  // Only the player whose turn it is can run out of time
  if (timedOutColor !== currentTurnColor) {
    throw new Error(
      `Cannot flag ${timedOutColor} for timeout — it is ${currentTurnColor}'s turn`,
    )
  }

  const elapsed = Date.now() - match.clock_last_updated
  const clockRemaining =
    timedOutColor === 'white'
      ? match.clock_white - elapsed
      : match.clock_black - elapsed

  // Allow 5 seconds of grace for network latency
  const GRACE_MS = 5_000
  if (clockRemaining > GRACE_MS) {
    throw new Error(
      `Clock has not expired (${Math.ceil(clockRemaining / 1000)}s remaining)`,
    )
  }

  // ── Complete the match ──────────────────────────────────────────────────────

  const winner = timedOutColor === 'white' ? 'black' : 'white'

  // Optimistic lock: only complete if still active
  const { data: updated, error } = await supabase
    .from('matches')
    .update({
      status: 'completed',
      ended_at: new Date().toISOString(),
      winner,
      result_reason: 'timeout',
      prize_amount: match.stake_amount * 2,
    })
    .eq('id', matchId)
    .eq('status', 'active')
    .select('id')

  if (error) throw new Error(error.message)
  // If 0 rows updated, another process already completed the match — that's fine
  if (!updated || updated.length === 0) return

  autoDisburse(matchId).catch(console.error)
}

/**
 * Cancels a match that never started and refunds any stakes already sent.
 * Works for matches in 'waiting' or 'staking' status only.
 * Full refund — no platform fee — because no game was played.
 */
export async function abandonMatch(matchId: string, publicKey: string): Promise<void> {
  const match = await getMatch(matchId)

  if (!['waiting', 'staking'].includes(match.status)) {
    throw new Error('Match can only be abandoned before both players have staked')
  }

  const isHost = match.host_public_key === publicKey
  const isGuest = match.guest_public_key === publicKey
  if (!isHost && !isGuest) throw new Error('Not a participant')

  // Determine who has staked and how much to refund
  const refunds: Array<{ address: string; amount: number }> = []
  if (match.host_staked) {
    refunds.push({ address: match.host_public_key, amount: match.stake_amount })
  }
  if (match.guest_staked && match.guest_public_key) {
    refunds.push({ address: match.guest_public_key, amount: match.stake_amount })
  }

  const totalRefund = refunds.reduce((sum, r) => sum + r.amount, 0)

  // Atomically cancel — only if still in a pre-game status
  const { data: cancelled, error } = await supabase
    .from('matches')
    .update({
      status: 'cancelled',
      ended_at: new Date().toISOString(),
      result_reason: 'abandoned',
      prize_amount: totalRefund,
    })
    .eq('id', matchId)
    .in('status', ['waiting', 'staking'])
    .select('id')

  if (error) throw new Error(error.message)
  if (!cancelled || cancelled.length === 0) {
    throw new Error('Match cannot be abandoned (status changed — try again)')
  }

  // Issue refunds
  if (refunds.length === 0) return

  const txSigs: string[] = []
  for (const refund of refunds) {
    try {
      const sig = await sendRefund(refund.address, refund.amount)
      txSigs.push(`${refund.address}:${sig}`)
    } catch (err) {
      console.error(`[abandon] Failed to refund ${refund.address}:`, err)
    }
  }

  if (txSigs.length > 0) {
    await recordPrizeTx(matchId, txSigs.join(';'))
  }
}

export async function recordPrizeTx(matchId: string, prizeTx: string): Promise<void> {
  const { error } = await supabase
    .from('matches')
    .update({ prize_tx: prizeTx })
    .eq('id', matchId)
  if (error) throw new Error(error.message)
}
