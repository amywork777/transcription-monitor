import { type NextRequest, NextResponse } from "next/server"

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const webhookUrl = searchParams.get("url")
  const apiKey = searchParams.get("apiKey")

  if (!webhookUrl) {
    return NextResponse.json({ error: "Missing webhook URL" }, { status: 400 })
  }

  try {
    console.log("[v0] Fetching from webhook URL:", webhookUrl)

    const headers: Record<string, string> = {
      "User-Agent": "TranscriptionMonitor/1.0",
      Accept: "application/json",
    }

    if (apiKey) {
      headers["Api-Key"] = apiKey
    }

    // Try the /request/latest endpoint first as it's more direct
    let finalUrl = webhookUrl
    if (webhookUrl.includes("/requests")) {
      finalUrl = webhookUrl.replace("/requests?sorting=newest&size=1", "/request/latest")
      finalUrl = finalUrl.replace("/requests", "/request/latest")
    }

    console.log("[v0] Trying latest request endpoint:", finalUrl)

    const response = await fetch(finalUrl, { headers })

    if (!response.ok) {
      console.log("[v0] Webhook fetch failed:", response.status, response.statusText)

      if ((response.status === 401 || response.status === 404) && finalUrl !== webhookUrl) {
        console.log("[v0] Retrying with original URL:", webhookUrl)
        const retryResponse = await fetch(webhookUrl, { headers })

        if (!retryResponse.ok) {
          return NextResponse.json(
            {
              error: `Webhook API returned ${retryResponse.status}: ${retryResponse.statusText}. This token may require an API key.`,
              needsApiKey: retryResponse.status === 401,
            },
            { status: retryResponse.status },
          )
        }

        return await processResponse(retryResponse)
      }

      return NextResponse.json(
        {
          error: `Webhook API returned ${response.status}: ${response.statusText}. This token may require an API key.`,
          needsApiKey: response.status === 401,
        },
        { status: response.status },
      )
    }

    return await processResponse(response)
  } catch (error) {
    console.error("[v0] Webhook proxy error:", error)
    return NextResponse.json(
      { error: `Failed to fetch webhook data: ${error instanceof Error ? error.message : "Unknown error"}` },
      { status: 500 },
    )
  }
}

async function processResponse(response: Response) {
  const responseText = await response.text()
  console.log("[v0] Response content type:", response.headers.get("content-type"))
  console.log("[v0] Response text preview:", responseText.substring(0, 100))

  try {
    const data = JSON.parse(responseText)

    // Handle both single request and array of requests
    if (data.id) {
      // Single request from /request/latest endpoint
      console.log("[v0] Successfully parsed single request")
      return NextResponse.json({ data: [data] })
    } else if (data.data) {
      // Array of requests from /requests endpoint
      console.log("[v0] Successfully parsed JSON, requests count:", data.data.length)
      return NextResponse.json(data)
    } else {
      console.log("[v0] Successfully parsed JSON, treating as single request")
      return NextResponse.json({ data: [data] })
    }
  } catch (parseError) {
    console.log("[v0] Response is not JSON, returning error")
    return NextResponse.json(
      {
        error: `Webhook returned non-JSON response. Content: ${responseText.substring(0, 200)}...`,
        contentType: response.headers.get("content-type"),
      },
      { status: 400 },
    )
  }
}
