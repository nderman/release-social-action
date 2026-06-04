// Thin fetch wrapper so transport is injectable/mockable. The real client uses
// Node 20's global fetch; no axios/node-fetch dependency.

import { HttpClient, HttpRequest, HttpResponse } from './types';

export const fetchHttpClient: HttpClient = async (
  req: HttpRequest
): Promise<HttpResponse> => {
  const res = await fetch(req.url, {
    method: req.method,
    headers: req.headers,
    body: req.body
  });

  const headers: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });

  const text = await res.text();
  let body: unknown = text;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  return { status: res.status, headers, body };
};
