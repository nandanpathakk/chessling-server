import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
  ParsedTransactionWithMeta,
} from '@solana/web3.js'

export const PLATFORM_FEE_BPS = 500 // 5%

let _connection: Connection | null = null
let _treasury: Keypair | null = null

function getConnection(): Connection {
  if (!_connection) {
    const rpc = process.env.SOLANA_RPC_URL
    if (!rpc) throw new Error('Missing SOLANA_RPC_URL')
    _connection = new Connection(rpc, 'confirmed')
  }
  return _connection
}

function getTreasury(): Keypair {
  if (!_treasury) {
    const secretB64 = process.env.TREASURY_SECRET_KEY
    if (!secretB64) throw new Error('Missing TREASURY_SECRET_KEY')
    const secretBytes = Buffer.from(secretB64, 'base64')
    _treasury = Keypair.fromSecretKey(secretBytes)
  }
  return _treasury
}

/**
 * Verifies that a transaction signature is a valid transfer of exact lamports
 * from the sender to the treasury.
 */
export async function verifyStakeTransaction(
  signature: string,
  expectedLamports: number,
  expectedSender: string,
): Promise<void> {
  const connection = getConnection()
  const treasury = getTreasury()

  // Wait for the transaction to be confirmed
  await connection.confirmTransaction(signature, 'confirmed')

  const tx: ParsedTransactionWithMeta | null = await connection.getParsedTransaction(signature, {
    maxSupportedTransactionVersion: 0,
  })

  if (!tx) throw new Error('Transaction not found or not confirmed')
  if (tx.meta?.err) throw new Error('Transaction failed on-chain')

  // Find the system program transfer instruction
  const transferInstr = tx.transaction.message.instructions.find((ix: any) => {
    return (
      ix.program === 'system' &&
      ix.parsed?.type === 'transfer' &&
      ix.parsed?.info?.destination === treasury.publicKey.toBase58() &&
      ix.parsed?.info?.source === expectedSender
    )
  })

  if (!transferInstr) {
    throw new Error('Valid transfer instruction to treasury not found in transaction')
  }

  const transferredLamports = (transferInstr as any).parsed.info.lamports
  if (transferredLamports < expectedLamports) {
    throw new Error(`Insufficient stake. Expected ${expectedLamports}, got ${transferredLamports}`)
  }
}

/**
 * Sends the winner's prize from treasury: total pot minus 5% platform fee.
 */
export async function sendPrize(
  winnerAddress: string,
  totalPotLamports: number,
): Promise<string> {
  const connection = getConnection()
  const treasury = getTreasury()

  const fee = Math.floor((totalPotLamports * PLATFORM_FEE_BPS) / 10_000)
  const payout = totalPotLamports - fee

  if (payout <= 0) throw new Error('Payout too small after fees')

  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: treasury.publicKey,
      toPubkey: new PublicKey(winnerAddress),
      lamports: payout,
    }),
  )

  const signature = await sendAndConfirmTransaction(connection, tx, [treasury], {
    commitment: 'confirmed',
  })

  console.log(
    `[prize] Winner: sent ${payout / LAMPORTS_PER_SOL} SOL to ${winnerAddress} | tx: ${signature}`,
  )

  return signature
}

/**
 * Sends each player their stake back minus their share of the platform fee.
 * Used for drawn games.
 *
 * Each player receives: (totalPot - 5% fee) / 2
 *
 * Returns both tx signatures encoded as "host:<sig1>;guest:<sig2>".
 * Throws if either transaction fails — caller should handle partial failure.
 */
export async function sendDrawRefunds(
  hostAddress: string,
  guestAddress: string,
  totalPotLamports: number,
): Promise<{ hostTx: string; guestTx: string }> {
  const connection = getConnection()
  const treasury = getTreasury()

  const fee = Math.floor((totalPotLamports * PLATFORM_FEE_BPS) / 10_000)
  const eachPayout = Math.floor((totalPotLamports - fee) / 2)

  if (eachPayout <= 0) throw new Error('Draw payout too small after fees')

  const hostTxObj = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: treasury.publicKey,
      toPubkey: new PublicKey(hostAddress),
      lamports: eachPayout,
    }),
  )
  const hostSig = await sendAndConfirmTransaction(connection, hostTxObj, [treasury], {
    commitment: 'confirmed',
  })
  console.log(
    `[prize] Draw host: sent ${eachPayout / LAMPORTS_PER_SOL} SOL to ${hostAddress} | tx: ${hostSig}`,
  )

  const guestTxObj = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: treasury.publicKey,
      toPubkey: new PublicKey(guestAddress),
      lamports: eachPayout,
    }),
  )
  const guestSig = await sendAndConfirmTransaction(connection, guestTxObj, [treasury], {
    commitment: 'confirmed',
  })
  console.log(
    `[prize] Draw guest: sent ${eachPayout / LAMPORTS_PER_SOL} SOL to ${guestAddress} | tx: ${guestSig}`,
  )

  return { hostTx: hostSig, guestTx: guestSig }
}

/**
 * Returns a full refund to a single player with NO platform fee.
 * Used for cancelled/abandoned matches where no game was played.
 */
export async function sendRefund(
  playerAddress: string,
  amountLamports: number,
): Promise<string> {
  const connection = getConnection()
  const treasury = getTreasury()

  if (amountLamports <= 0) throw new Error('Refund amount must be positive')

  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: treasury.publicKey,
      toPubkey: new PublicKey(playerAddress),
      lamports: amountLamports,
    }),
  )

  const signature = await sendAndConfirmTransaction(connection, tx, [treasury], {
    commitment: 'confirmed',
  })

  console.log(
    `[prize] Refund: sent ${amountLamports / LAMPORTS_PER_SOL} SOL to ${playerAddress} | tx: ${signature}`,
  )

  return signature
}

/** Checks the treasury balance (for monitoring). */
export async function getTreasuryBalance(): Promise<number> {
  const connection = getConnection()
  const treasury = getTreasury()
  return connection.getBalance(treasury.publicKey)
}
