const UPSTREAM_ORIGIN =
  "https://up2cloud-ai-assistant.vercel.app";

/**
 * Expose the Vercel-hosted assistant below the UP2CLOUD website path while
 * keeping the public URL on up2cloud.tech.
 */
export async function onRequest({ request }) {
  const incomingUrl = new URL(request.url);
  const upstreamPath = incomingUrl.pathname.replace(
    /^\/ai-assistent-model\/?/,
    "/",
  );
  const upstreamUrl = new URL(
    `${upstreamPath}${incomingUrl.search}`,
    UPSTREAM_ORIGIN,
  );

  const requestHeaders = new Headers(request.headers);
  requestHeaders.delete("host");

  const requestInit = {
    method: request.method,
    headers: requestHeaders,
    redirect: "manual",
  };

  if (request.method !== "GET" && request.method !== "HEAD") {
    requestInit.body = request.body;
  }

  try {
    const upstreamResponse = await fetch(upstreamUrl, requestInit);
    const responseHeaders = new Headers(upstreamResponse.headers);
    const location = responseHeaders.get("location");

    if (location?.startsWith(UPSTREAM_ORIGIN)) {
      responseHeaders.set(
        "location",
        location.replace(UPSTREAM_ORIGIN, `${incomingUrl.origin}/ai-assistent-model`),
      );
    }

    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: responseHeaders,
    });
  } catch (error) {
    console.error("Assistant upstream request failed", error);
    return Response.json(
      { error: "The UP2CLOUD assistant is temporarily unavailable." },
      { status: 502 },
    );
  }
}
