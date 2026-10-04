// Event subscriptions only: registration must remain inert.
export function serviceInfo(value) {
  if (!value || typeof value !== 'object' || typeof value.socket !== 'string' ||
      !value.socket.startsWith('/') || value.socket.includes('\0') ||
      !Number.isSafeInteger(value.pid) || value.pid < 1) return;
  return { socket: value.socket, pid: value.pid };
}
export function bindDiscovery(pi, client) {
  const accept = value => client.setService(serviceInfo(value));
  const discover = () => pi.events.emit('nvim-service:get', { reply: accept });
  pi.events.on('nvim-service:ready', accept);
  pi.events.on('nvim-service:stopped', value => {
    const stopped = serviceInfo(value);
    if (stopped?.socket === client.service?.socket && stopped?.pid === client.service?.pid) client.setService(undefined);
  });
  pi.on('session_start', discover);
  pi.on('session_shutdown', () => client.close());
  return discover;
}
