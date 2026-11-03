/**
 * The two reads this plugin's browser half makes: one JSON GET, one JSON POST,
 * both against its own authenticated routes.
 *
 * A failed request throws with the status in the message, so a caller can tell a
 * route this process never registered (`404`, a host older than the page) from an
 * ordinary failure.
 *
 * @module dsh-git/src/client/api
 */

/**
 * Read one JSON answer from this plugin's own route.
 * @param path - the route.
 * @param query - parameters to send; an empty value is left out.
 * @param signal - cancellation, so a superseded read stops waiting.
 * @returns the decoded body.
 * @throws {Error} when the route answered a non-success status.
 */
export async function readJson<T>(path: string, query: Record<string, string>, signal: AbortSignal): Promise<T> {
  const url = new URL(path, window.location.origin)
  for (const [key, value] of Object.entries(query)) {
    if (value.length > 0) url.searchParams.set(key, value)
  }
  const response = await fetch(url, { signal, headers: { accept: 'application/json' } })
  if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
  return await response.json() as T
}

/**
 * Post one JSON body to this plugin's own route.
 * @param path - the route.
 * @param body - the JSON body.
 * @param signal - cancellation.
 * @returns the decoded answer.
 * @throws {Error} when the route answered a non-success status.
 */
export async function sendJson<T>(path: string, body: unknown, signal: AbortSignal): Promise<T> {
  const response = await fetch(new URL(path, window.location.origin), {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
  return await response.json() as T
}
