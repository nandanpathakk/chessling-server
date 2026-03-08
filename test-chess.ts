import { Chess } from 'chess.js'

const game = new Chess()
try {
  game.move({ from: 'e2', to: 'e4', promotion: 'q' })
  console.log("Success")
} catch (e: any) {
  console.log("Error:", e.message)
}
