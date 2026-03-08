-- ChessBet Supabase schema
-- Run this in your Supabase project → SQL editor

CREATE TABLE IF NOT EXISTS matches (
  id                  TEXT        PRIMARY KEY,
  code                CHAR(6)     UNIQUE NOT NULL,
  status              TEXT        NOT NULL DEFAULT 'waiting',
    -- 'waiting' | 'staking' | 'active' | 'completed' | 'cancelled'

  stake_amount        BIGINT      NOT NULL,   -- lamports per player
  time_control        INTEGER     NOT NULL,   -- seconds per player

  host_public_key     TEXT        NOT NULL,
  host_color          TEXT        NOT NULL DEFAULT 'white',
  host_staked         BOOLEAN     NOT NULL DEFAULT FALSE,
  host_tx             TEXT,

  guest_public_key    TEXT,
  guest_color         TEXT,
  guest_staked        BOOLEAN     NOT NULL DEFAULT FALSE,
  guest_tx            TEXT,

  -- Game state (FEN + metadata)
  fen                 TEXT        NOT NULL,
  pgn                 TEXT        NOT NULL DEFAULT '',
  moves               TEXT[]      NOT NULL DEFAULT '{}',
  turn                CHAR(1)     NOT NULL DEFAULT 'w',
  last_move_from      TEXT,
  last_move_to        TEXT,
  move_count          INTEGER     NOT NULL DEFAULT 0,

  -- Clocks in milliseconds
  clock_white         BIGINT      NOT NULL,
  clock_black         BIGINT      NOT NULL,
  clock_last_updated  BIGINT      NOT NULL,
  clock_last_turn     CHAR(1),

  -- Result
  winner              TEXT,        -- 'white' | 'black' | 'draw'
  result_reason       TEXT,        -- 'checkmate' | 'timeout' | 'resignation' | 'stalemate' | 'draw'
  prize_amount        BIGINT,
  prize_tx            TEXT,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at          TIMESTAMPTZ,
  ended_at            TIMESTAMPTZ
);

-- Indexes for common lookups
CREATE INDEX IF NOT EXISTS idx_matches_code   ON matches (code);
CREATE INDEX IF NOT EXISTS idx_matches_status ON matches (status);
CREATE INDEX IF NOT EXISTS idx_matches_host   ON matches (host_public_key);
CREATE INDEX IF NOT EXISTS idx_matches_guest  ON matches (guest_public_key);

-- Unique constraints to prevent transaction replay
ALTER TABLE matches ADD CONSTRAINT unique_host_tx UNIQUE (host_tx);
ALTER TABLE matches ADD CONSTRAINT unique_guest_tx UNIQUE (guest_tx);

-- Enable Supabase Realtime for the matches table
-- (Do this in: Supabase dashboard → Database → Replication → Realtime → matches toggle ON)
ALTER PUBLICATION supabase_realtime ADD TABLE matches;

-- Row Level Security: allow all for now (tighten before mainnet)
ALTER TABLE matches ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all reads" ON matches FOR SELECT USING (true);
-- Writes go through the backend (service role key), not the anon key
