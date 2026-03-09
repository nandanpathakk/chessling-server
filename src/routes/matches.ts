import { Router, Request, Response } from 'express'
import {
  createMatch,
  createLocalPlayMatch,
  getMatchByCode,
  getMatchResolved,
  joinMatch,
  confirmStake,
  applyMove,
  resignMatch,
  flagTimeout,
  abandonMatch,
  recordPrizeTx,
  resolveWinnerAddress,
} from '../services/match.service'
import { sendPrize, sendDrawRefunds } from '../services/prize.service'
import { supabase } from '../supabase'

export const matchRouter = Router()

// ── Helpers ──────────────────────────────────────────────────────────────────

function ok(res: Response, data: unknown) {
  res.json(data)
}

function err(res: Response, status: number, message: string) {
  res.status(status).json({ error: message })
}

function wrap(fn: (req: Request, res: Response) => Promise<void>) {
  return async (req: Request, res: Response) => {
    try {
      await fn(req, res)
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Internal server error'
      console.error('[route error]', message)
      err(res, 400, message)
    }
  }
}

// ── Routes ───────────────────────────────────────────────────────────────────

/** POST /api/matches — Create a new match */
matchRouter.post(
  '/',
  wrap(async (req, res) => {
    const { hostPublicKey, stakeAmount, timeControl } = req.body
    if (!hostPublicKey || stakeAmount === undefined || !timeControl) {
      return err(res, 400, 'hostPublicKey, stakeAmount, and timeControl are required')
    }
    if (stakeAmount < 0) return err(res, 400, 'Stake cannot be negative')
    if (![60, 120, 180].includes(timeControl)) return err(res, 400, 'Invalid time control')

    const result = await createMatch(hostPublicKey, stakeAmount, timeControl)
    ok(res, result)
  }),
)

/** POST /api/matches/local-play — Instantly create a dual-sided development match */
matchRouter.post(
  '/local-play',
  wrap(async (req, res) => {
    const { publicKey } = req.body
    if (!publicKey) return err(res, 400, 'publicKey is required')

    const result = await createLocalPlayMatch(publicKey)
    ok(res, { matchId: result.id })
  }),
)

/** GET /api/matches/code/:code — Look up match by 6-char code */
matchRouter.get(
  '/code/:code',
  wrap(async (req, res) => {
    const code = String(req.params.code)
    // getMatchByCode returns raw data; apply clock resolution after
    const raw = await getMatchByCode(code)
    const match = raw.status === 'active' ? await getMatchResolved(raw.id) : raw
    ok(res, match)
  }),
)

/** GET /api/matches/:id — Get match by ID */
matchRouter.get(
  '/:id',
  wrap(async (req, res) => {
    const id = String(req.params.id)
    // Lazily resolve expired clocks (P1) so callers always see true state
    const match = await getMatchResolved(id)
    ok(res, match)
  }),
)

/** POST /api/matches/:id/join — Guest joins the match */
matchRouter.post(
  '/:id/join',
  wrap(async (req, res) => {
    const id = String(req.params.id)
    const { guestPublicKey } = req.body
    if (!guestPublicKey) return err(res, 400, 'guestPublicKey is required')
    await joinMatch(id, guestPublicKey)
    ok(res, { joined: true })
  }),
)

/** POST /api/matches/:id/stake — Record a player's stake transaction */
matchRouter.post(
  '/:id/stake',
  wrap(async (req, res) => {
    const id = String(req.params.id)
    const { publicKey, txSignature } = req.body
    if (!publicKey || !txSignature) return err(res, 400, 'publicKey and txSignature are required')

    // TODO (production): verify the txSignature transaction to confirm the SOL
    // actually arrived at the treasury before marking as staked.

    const result = await confirmStake(id, publicKey, txSignature)
    ok(res, result)
  }),
)

/** POST /api/matches/:id/move — Validate and apply a chess move */
matchRouter.post(
  '/:id/move',
  wrap(async (req, res) => {
    const id = String(req.params.id)
    const { publicKey, from, to, newClockMs } = req.body
    if (!publicKey || !from || !to || newClockMs === undefined) {
      return err(res, 400, 'publicKey, from, to, and newClockMs are required')
    }
    await applyMove(id, publicKey, from, to, newClockMs)
    ok(res, { applied: true })
  }),
)

/** POST /api/matches/:id/resign — A player resigns */
matchRouter.post(
  '/:id/resign',
  wrap(async (req, res) => {
    const id = String(req.params.id)
    const { publicKey } = req.body
    if (!publicKey) return err(res, 400, 'publicKey is required')
    await resignMatch(id, publicKey)
    ok(res, { resigned: true })
  }),
)

/** POST /api/matches/:id/timeout — Flag a player as timed out (server verifies) */
matchRouter.post(
  '/:id/timeout',
  wrap(async (req, res) => {
    const id = String(req.params.id)
    const { timedOutColor } = req.body
    if (!timedOutColor) return err(res, 400, 'timedOutColor is required')
    await flagTimeout(id, timedOutColor)
    ok(res, { flagged: true })
  }),
)

/** POST /api/matches/:id/abandon — Cancel a pre-game match and refund stakes */
matchRouter.post(
  '/:id/abandon',
  wrap(async (req, res) => {
    const id = String(req.params.id)
    const { publicKey } = req.body
    if (!publicKey) return err(res, 400, 'publicKey is required')
    await abandonMatch(id, publicKey)
    ok(res, { abandoned: true })
  }),
)

/**
 * POST /api/matches/:id/claim — Manual fallback for prize collection.
 *
 * Prizes are normally auto-disbursed immediately when a match completes.
 * This endpoint is a safety net for cases where auto-disbursement failed
 * (e.g. treasury temporarily out of funds, network error).
 *
 * For draws: either player can trigger both refunds.
 * For wins: only the winner can claim.
 *
 * Uses an atomic DB update to prevent double-payment even under concurrent requests.
 */
matchRouter.post(
  '/:id/claim',
  wrap(async (req, res) => {
    const id = String(req.params.id)
    const { publicKey } = req.body
    if (!publicKey) return err(res, 400, 'publicKey is required')

    // Use getMatchResolved in case the match completed via clock expiry but
    // the client doesn't know yet (P1 lazy check applies here too)
    const match = await getMatchResolved(id)
    if (match.status !== 'completed') return err(res, 400, 'Match is not completed')

    // 'pending' means auto-disburse is in progress — tell client to retry shortly
    if (match.prize_tx === 'pending') {
      return err(res, 409, 'Disbursement in progress — try again in a few seconds')
    }
    // Any other non-null value means already paid
    if (match.prize_tx) return err(res, 400, 'Prize already disbursed')

    if (!match.prize_amount || match.prize_amount <= 0) {
      return err(res, 400, 'No prize recorded for this match')
    }

    // Validate the caller is a participant
    const isHost = match.host_public_key === publicKey
    const isGuest = match.guest_public_key === publicKey
    if (!isHost && !isGuest) return err(res, 403, 'Not a participant in this match')

    // For winner-takes-all: only the winner may claim
    if (match.winner !== 'draw') {
      const winnerAddress = resolveWinnerAddress(match)
      if (!winnerAddress) return err(res, 400, 'Cannot determine winner address')
      if (publicKey !== winnerAddress) return err(res, 403, 'Only the winner can claim')
    }

    // ── Atomic claim slot (prevents double-payment under concurrent requests) ──
    const { data: slotClaimed, error: slotErr } = await supabase
      .from('matches')
      .update({ prize_tx: 'pending' })
      .eq('id', id)
      .eq('status', 'completed')
      .is('prize_tx', null)
      .select('id')

    if (slotErr) return err(res, 500, 'Failed to claim prize slot')
    if (!slotClaimed || slotClaimed.length === 0) {
      return err(res, 409, 'Prize already claimed by a concurrent request')
    }

    // ── Send payment ──────────────────────────────────────────────────────────
    try {
      let prizeTx: string

      if (match.winner === 'draw') {
        if (!match.guest_public_key) throw new Error('Draw but guest address is missing')
        const { hostTx, guestTx } = await sendDrawRefunds(
          match.host_public_key,
          match.guest_public_key,
          match.prize_amount,
        )
        prizeTx = `host:${hostTx};guest:${guestTx}`
      } else {
        const winnerAddress = resolveWinnerAddress(match)!
        prizeTx = await sendPrize(winnerAddress, match.prize_amount)
      }

      await recordPrizeTx(id, prizeTx)
      ok(res, { prizeTx })
    } catch (payErr) {
      // Payment failed — reset slot so the player can retry
      await supabase
        .from('matches')
        .update({ prize_tx: null })
        .eq('id', id)
        .eq('prize_tx', 'pending')

      throw payErr // re-thrown so wrap() returns a 400 with the error message
    }
  }),
)
