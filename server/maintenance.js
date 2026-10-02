let maintenance = false;
let activeRequests = 0;
let waiters = [];

export function trackApiRequest(req, res, next) {
  if (maintenance) return res.status(503).json({ message: '系统正在恢复备份，请稍后重试' });
  activeRequests += 1;
  let finished = false;
  const done = () => {
    if (finished) return;
    finished = true;
    activeRequests -= 1;
    if (activeRequests <= (maintenance ? 1 : 0)) {
      for (const resolve of waiters) resolve();
      waiters = [];
    }
  };
  res.once('finish', done);
  res.once('close', done);
  next();
}

export async function beginRestore() {
  if (maintenance) throw new Error('已有备份恢复正在进行');
  maintenance = true;
  // The restore request itself remains active until it sends a response.
  if (activeRequests > 1) await new Promise(resolve => waiters.push(resolve));
}

export function endRestore() {
  maintenance = false;
}
