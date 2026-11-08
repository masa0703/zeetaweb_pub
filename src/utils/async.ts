// Promise に上限時間を付ける。外部サービス（Workers AI / Vectorize / D1）の呼び出しが
// まれにハングして応答しなくなると、リクエスト全体が 524 になるため、await を必ず有界にする。
// タイムアウト時は fallback を返す（裏で元の処理が完了しても冪等なので害はない）。
export function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ])
}
