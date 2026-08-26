export function createLimiter({ concurrency = 2, maxQueued = 32, queueTimeoutMs = 15_000 } = {}) {
  let active = 0
  const queue = []
  const unavailable = () => Object.assign(new Error('腾讯云语音请求较多，请稍后重试'), { statusCode: 503 })
  return (task) => new Promise((resolve, reject) => {
    const job = {
      timer: null,
      run() {
        clearTimeout(job.timer)
        active++
        void Promise.resolve().then(task).then(resolve, reject).finally(() => {
          active--
          queue.shift()?.run()
        })
      },
    }
    if (active < concurrency) job.run()
    else if (queue.length >= maxQueued) reject(unavailable())
    else {
      queue.push(job)
      job.timer = setTimeout(() => {
        const index = queue.indexOf(job)
        if (index >= 0) { queue.splice(index, 1); reject(unavailable()) }
      }, queueTimeoutMs)
    }
  })
}
