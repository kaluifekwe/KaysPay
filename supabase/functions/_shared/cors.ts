type CorsHeaders = {
  "Access-Control-Allow-Origin": string;
  "Access-Control-Allow-Headers": string;
  "Access-Control-Allow-Methods": string;
};

const BASE_HEADERS: Omit<CorsHeaders, "Access-Control-Allow-Origin"> = {
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
};

export function corsHeaders(allowedOrigin?: string): CorsHeaders {
  return {
    "Access-Control-Allow-Origin": allowedOrigin || "*",
    ...BASE_HEADERS,
  };
}

export function handleCors(req: Request, allowedOrigin?: string): Response | null {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders(allowedOrigin) });
  }
  return null;
}
