// Tunnel is no longer needed — files are uploaded directly to VPS via rsync
// and served by nginx. This file is kept for backwards compatibility.

export async function startTunnel(_port: number) {
  return {
    publicUrl: (process.env.VPS_PUBLIC_URL ?? "").replace(/\/$/, ""),
    stop: () => {},
  };
}
