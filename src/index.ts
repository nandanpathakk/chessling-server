import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { matchRouter } from './routes/matches'
import { supabase } from './supabase'
import { flagTimeout, abandonMatch } from './services/match.service'

const PORT = process.env.PORT ?? 3001

const app = express()

// ── Startup cleanup ───────────────────────────────────────────────────────────

/**
 * Reset any matches whose prize_tx is stuck as 'pending'.
 * Happens when the server crashed mid-disbursement.
 * Releasing the slot allows autoDisburse / /claim to retry.
 */
async function resetStuckPendingDisburse(): Promise<void> {
  const { error, data } = await supabase
    .from('matches')
    .update({ prize_tx: null })
    .eq('prize_tx', 'pending')
    .select('id')

  if (error) {
    console.error('[startup] Failed to reset pending disbursements:', error.message)
  } else if (data && data.length > 0) {
    console.log(`[startup] Reset ${data.length} stuck pending disbursement(s)`)
  }
}

// ── Cron: sweep active matches with expired clocks (P2) ───────────────────────

/**
 * Finds all active matches where the current player's clock has run out and
 * no client ever called POST /timeout (e.g. both players closed the app).
 *
 * Runs every 60 seconds. Combined with the lazy check in getMatchResolved,
 * this closes every path where a timed-out game could stay "active" forever.
 */
async function sweepExpiredActiveMatches(): Promise<void> {
  const { data: matches, error } = await supabase
    .from('matches')
    .select('id, turn, clock_white, clock_black, clock_last_updated')
    .eq('status', 'active')

  if (error) {
    console.error('[sweep:active] Query failed:', error.message)
    return
  }
  if (!matches || matches.length === 0) return

  const now = Date.now()
  const expired = matches.filter((m) => {
    const elapsed = now - m.clock_last_updated
    const currentClock = m.turn === 'w' ? m.clock_white : m.clock_black
    return currentClock - elapsed <= 0
  })

  if (expired.length === 0) return

  console.log(`[sweep:active] Found ${expired.length} expired match(es), completing...`)

  // Process sequentially to avoid overwhelming the treasury with concurrent txs
  for (const m of expired) {
    const timedOutColor = m.turn === 'w' ? 'white' : 'black'
    try {
      await flagTimeout(m.id, timedOutColor)
      console.log(`[sweep:active] Completed match ${m.id} — ${timedOutColor} timed out`)
    } catch (e) {
      // Could be already completed by another process — log and continue
      console.error(`[sweep:active] Match ${m.id}: ${(e as Error).message}`)
    }
  }
}

// ── Cron: sweep stale pre-game matches (P3) ───────────────────────────────────

/** Staking phase deadline: cancel if neither player finished staking within this window. */
const STAKING_TIMEOUT_MS = 5 * 60 * 1000  // 5 minutes

/** Waiting phase deadline: clean up matches nobody ever joined. */
const WAITING_TIMEOUT_MS = 30 * 60 * 1000 // 30 minutes

/**
 * Auto-cancels matches stuck in the pre-game phases:
 *
 * - 'staking': one or both players haven't staked after 15 minutes.
 *   Any stakes already sent are fully refunded (no fee — no game was played).
 *
 * - 'waiting': nobody joined the match after 30 minutes.
 *   No stakes to refund; just marks the match as cancelled.
 *
 * Runs every 5 minutes.
 */
async function sweepStaleMatches(): Promise<void> {
  const now = Date.now()

  // ── Stale staking matches ────────────────────────────────────────────────
  const stakingCutoff = new Date(now - STAKING_TIMEOUT_MS).toISOString()
  const { data: staleStaking, error: stakingErr } = await supabase
    .from('matches')
    .select('id, host_public_key')
    .eq('status', 'staking')
    .lt('created_at', stakingCutoff)

  if (stakingErr) {
    console.error('[sweep:stale] Staking query failed:', stakingErr.message)
  } else if (staleStaking && staleStaking.length > 0) {
    console.log(`[sweep:stale] Found ${staleStaking.length} stale staking match(es), cancelling...`)
    for (const m of staleStaking) {
      try {
        // abandonMatch refunds whoever staked and sets status = 'cancelled'
        await abandonMatch(m.id, m.host_public_key)
        console.log(`[sweep:stale] Cancelled staking match ${m.id}`)
      } catch (e) {
        console.error(`[sweep:stale] Match ${m.id}: ${(e as Error).message}`)
      }
    }
  }

  // ── Stale waiting matches (nobody joined, no stakes to refund) ────────────
  const waitingCutoff = new Date(now - WAITING_TIMEOUT_MS).toISOString()
  const { error: waitingErr } = await supabase
    .from('matches')
    .update({
      status: 'cancelled',
      ended_at: new Date(now).toISOString(),
      result_reason: 'abandoned',
    })
    .eq('status', 'waiting')
    .lt('created_at', waitingCutoff)

  if (waitingErr) {
    console.error('[sweep:stale] Waiting query failed:', waitingErr.message)
  }
}

// ── Startup + intervals ───────────────────────────────────────────────────────

async function runStartupTasks(): Promise<void> {
  await resetStuckPendingDisburse()
  // Immediately sweep any stale games that built up while the server was down
  await sweepExpiredActiveMatches().catch(console.error)
  await sweepStaleMatches().catch(console.error)
}

runStartupTasks().catch(console.error)

// P2: Sweep expired active games every 60 seconds
setInterval(() => {
  sweepExpiredActiveMatches().catch(console.error)
}, 60_000)

// P3: Sweep stale pre-game matches every 5 minutes
setInterval(() => {
  sweepStaleMatches().catch(console.error)
}, 5 * 60_000)

// ── Express app ───────────────────────────────────────────────────────────────

app.use(cors())
app.use(express.json())

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'chessbet-server', ts: Date.now() })
})

// Routes
app.use('/api/matches', matchRouter)

// 404 fallback
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' })
})

app.listen(PORT as number, '0.0.0.0', () => {
  console.log(`[chessbet-server] Listening on http://0.0.0.0:${PORT}`)
})
