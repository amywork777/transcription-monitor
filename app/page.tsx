"use client"

import { useState, useEffect, useRef } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible"
import { Play, Pause, RefreshCw, Settings, Download, Search, Clock, User, Globe, Mic, Circle } from "lucide-react"

interface TranscriptSegment {
  speaker: string
  text: string
  start: number
  end: number
  confidence?: number
  source?: string
  language?: string
  timestamp?: string
  id?: string
}

interface WebhookData {
  uuid: string
  method: string
  ip: string
  content: any
  created_at: string
}

interface Conversation {
  id: string
  startTime: Date
  endTime?: Date
  transcripts: TranscriptSegment[]
  status: "recording" | "completed"
  summary?: string
}

export default function TranscriptionMonitor() {
  const [isMonitoring, setIsMonitoring] = useState(false)
  const [hasRecentAudioBytes, setHasRecentAudioBytes] = useState(false)
  const [currentConversation, setCurrentConversation] = useState<Conversation | null>(null)
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [transcriptions, setTranscriptions] = useState<TranscriptSegment[]>([])
  const [transcriptionWebhookUrl, setTranscriptionWebhookUrl] = useState(
    "https://webhook.site/token/9a442af0-3269-4223-be14-ed4b60d81bc0/requests",
  )
  const [audioBytesWebhookUrl, setAudioBytesWebhookUrl] = useState(
    "https://webhook.site/token/d82d2c53-b568-4ac7-a9b9-808ce52fde1f/requests",
  )
  const [apiKey, setApiKey] = useState("debd5467-1359-4403-93d1-4260374cede0")
  const [pollingInterval, setPollingInterval] = useState(5000)
  const [searchTerm, setSearchTerm] = useState("")
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null)
  const [debugInfo, setDebugInfo] = useState<string[]>([])
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [processedRequestIds, setProcessedRequestIds] = useState<Set<string>>(new Set())
  const [processedSegmentIds, setProcessedSegmentIds] = useState<Set<string>>(new Set())
  const [lastAudioBytesRequestId, setLastAudioBytesRequestId] = useState<string | null>(null)
  const intervalRef = useRef<NodeJS.Timeout | null>(null)
  const recordingTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const processedRequestIdsRef = useRef<Set<string>>(new Set())
  const processedSegmentIdsRef = useRef<Set<string>>(new Set())
  const lastNewAudioBytesTime = useRef<Date | null>(null)
  const audioTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const [backoffDelay, setBackoffDelay] = useState(0)
  const backoffRef = useRef(0)

  useEffect(() => {
    try {
      const storedRequests = localStorage.getItem("transcription-processed-requests")
      const storedSegments = localStorage.getItem("transcription-processed-segments")

      if (storedRequests) {
        const parsedIds = JSON.parse(storedRequests)
        if (Array.isArray(parsedIds)) {
          const loadedSet = new Set(parsedIds)
          setProcessedRequestIds(loadedSet)
          processedRequestIdsRef.current = loadedSet
          addDebugInfo(`📂 Loaded ${loadedSet.size} processed request IDs from storage`)
          console.log("[v0] Loaded processed request IDs:", Array.from(loadedSet))
        }
      }

      if (storedSegments) {
        const parsedSegmentIds = JSON.parse(storedSegments)
        if (Array.isArray(parsedSegmentIds)) {
          const loadedSegmentSet = new Set(parsedSegmentIds)
          setProcessedSegmentIds(loadedSegmentSet)
          processedSegmentIdsRef.current = loadedSegmentSet
          addDebugInfo(`📂 Loaded ${loadedSegmentSet.size} processed segment IDs from storage`)
        }
      }
    } catch (error) {
      console.error("[v0] Failed to load processed IDs:", error)
      addDebugInfo("⚠️ Failed to load processed IDs from storage")
    }
  }, [])

  useEffect(() => {
    try {
      const requestIdsArray = Array.from(processedRequestIds)
      const segmentIdsArray = Array.from(processedSegmentIds)
      localStorage.setItem("transcription-processed-requests", JSON.stringify(requestIdsArray))
      localStorage.setItem("transcription-processed-segments", JSON.stringify(segmentIdsArray))
      console.log(
        "[v0] Saved processed IDs to localStorage - requests:",
        requestIdsArray.length,
        "segments:",
        segmentIdsArray.length,
      )
    } catch (error) {
      console.error("[v0] Failed to save processed IDs:", error)
    }
  }, [processedRequestIds, processedSegmentIds])

  useEffect(() => {
    // Auto-start monitoring when the page loads
    startMonitoring()
  }, [])

  const addDebugInfo = (message: string) => {
    const timestamp = new Date().toLocaleTimeString()
    setDebugInfo((prev) => [`[${timestamp}] ${message}`, ...prev.slice(0, 9)])
  }

  const checkAudioBytesWebhook = async () => {
    if (!audioBytesWebhookUrl.trim()) return

    try {
      await new Promise((resolve) => setTimeout(resolve, 200))

      const urlToUse = audioBytesWebhookUrl.includes("sorting=newest")
        ? audioBytesWebhookUrl
        : audioBytesWebhookUrl.includes("?")
          ? `${audioBytesWebhookUrl}&sorting=newest&size=1`
          : `${audioBytesWebhookUrl}?sorting=newest&size=1`

      let proxyUrl = `/api/webhook-proxy?url=${encodeURIComponent(urlToUse)}`
      if (apiKey.trim()) {
        proxyUrl += `&apiKey=${encodeURIComponent(apiKey.trim())}`
      }

      const response = await fetch(proxyUrl)

      if (response.status === 429) {
        console.log("[v0] Audio bytes check rate limited - skipping this cycle")
        return
      }

      if (!response.ok) return

      const data = await response.json()
      const webhookRequests: WebhookData[] = data.data || []

      if (webhookRequests.length > 0) {
        const latestRequest = webhookRequests[0]

        if (lastAudioBytesRequestId === null) {
          // First time - establish baseline without triggering recording
          console.log("[v0] Setting initial audio bytes baseline:", latestRequest.uuid)
          setLastAudioBytesRequestId(latestRequest.uuid)
          addDebugInfo(`📍 Set audio bytes baseline: ${latestRequest.uuid.slice(0, 8)}...`)
          return
        }

        if (latestRequest.uuid !== lastAudioBytesRequestId) {
          // NEW audio bytes detected - show recording
          console.log("[v0] NEW audio bytes detected - RECORDING STARTED:", latestRequest.uuid)
          addDebugInfo(`🔴 RECORDING: NEW audio bytes ${latestRequest.uuid.slice(0, 8)}...`)

          setLastAudioBytesRequestId(latestRequest.uuid)
          setHasRecentAudioBytes(true) // Show "Recording in Progress"

          // Clear any existing timeout
          if (audioTimeoutRef.current) {
            clearTimeout(audioTimeoutRef.current)
          }

          // Set 5-second timeout to stop recording if no new audio bytes
          audioTimeoutRef.current = setTimeout(() => {
            console.log("[v0] No new audio bytes for 5 seconds - RECORDING STOPPED")
            setHasRecentAudioBytes(false)
            addDebugInfo("⏹️ Recording stopped - no new audio for 5 seconds")
          }, 5000)
        } else {
          // Same UUID - no new audio bytes, but don't reset baseline
          console.log("[v0] Same audio bytes UUID - no new activity:", latestRequest.uuid)
        }
      } else {
        // No audio bytes requests found
        if (hasRecentAudioBytes) {
          setHasRecentAudioBytes(false)
          addDebugInfo("⏹️ No audio bytes requests - recording stopped")
        }
        console.log("[v0] No audio bytes requests found")
      }
    } catch (error) {
      if (!error.message?.includes("Too Many Requests")) {
        console.error("[v0] Audio bytes check error:", error)
      }
    }
  }

  const fetchTranscriptions = async () => {
    if (!transcriptionWebhookUrl.trim()) {
      addDebugInfo("❌ No transcription webhook URL configured")
      return
    }

    if (backoffRef.current > 0) {
      console.log(`[v0] Applying backoff delay: ${backoffRef.current}ms`)
      await new Promise((resolve) => setTimeout(resolve, backoffRef.current))
    }

    await checkAudioBytesWebhook()

    setIsLoading(true)
    addDebugInfo("🔄 Fetching transcription data...")

    try {
      const urlToUse = transcriptionWebhookUrl.includes("sorting=newest")
        ? transcriptionWebhookUrl
        : transcriptionWebhookUrl.includes("?")
          ? `${transcriptionWebhookUrl}&sorting=newest&size=1`
          : `${transcriptionWebhookUrl}?sorting=newest&size=1`

      let proxyUrl = `/api/webhook-proxy?url=${encodeURIComponent(urlToUse)}`
      if (apiKey.trim()) {
        proxyUrl += `&apiKey=${encodeURIComponent(apiKey.trim())}`
      }

      const response = await fetch(proxyUrl)

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: "Unknown error" }))

        if (response.status === 429 || errorData.error?.includes("Too Many Requests")) {
          backoffRef.current = Math.min(backoffRef.current * 2 || 2000, 30000) // Start at 2s, max 30s
          setBackoffDelay(backoffRef.current)
          addDebugInfo(`⏳ Rate limited - backing off for ${backoffRef.current / 1000}s`)
          return
        }

        if (response.status === 401) {
          setSettingsOpen(true)
          addDebugInfo("🔑 Authentication required - Please add your webhook.site API key")
        }
        throw new Error(errorData.error || `HTTP ${response.status}`)
      }

      if (backoffRef.current > 0) {
        backoffRef.current = 0
        setBackoffDelay(0)
        addDebugInfo("✅ Rate limit cleared - resuming normal polling")
      }

      const data = await response.json()
      const webhookRequests: WebhookData[] = data.data || []

      if (webhookRequests.length === 0) {
        addDebugInfo("ℹ️ No new transcription requests found")
        return
      }

      const newTranscriptions: TranscriptSegment[] = []

      for (const request of webhookRequests) {
        if (processedRequestIdsRef.current.has(request.uuid)) {
          continue
        }

        processedRequestIdsRef.current.add(request.uuid)

        try {
          let content = request.content
          if (typeof content === "string") {
            content = JSON.parse(content)
          }

          let segments: any[] = []
          if (content?.segments && Array.isArray(content.segments)) {
            segments = content.segments
          } else if (content?.transcript_segments && Array.isArray(content.transcript_segments)) {
            segments = content.transcript_segments
          }

          segments.forEach((segment: any) => {
            if (segment.text && segment.text.trim() && segment.start !== undefined) {
              const segmentKey = `${segment.id || ""}-${segment.text.trim()}-${segment.start}-${segment.end}`

              if (processedSegmentIdsRef.current.has(segmentKey)) {
                return
              }

              processedSegmentIdsRef.current.add(segmentKey)

              const transcription: TranscriptSegment = {
                speaker: segment.speaker || `SPEAKER_${segment.speaker_id || 0}`,
                text: segment.text.trim(),
                start: segment.start || 0,
                end: segment.end || 0,
                confidence: segment.confidence,
                source: request.method,
                language: content.language || segment.language || "en",
                timestamp: request.created_at,
                id: segment.id,
              }

              newTranscriptions.push(transcription)

              if (hasRecentAudioBytes && currentConversation) {
                setCurrentConversation((prev) =>
                  prev
                    ? {
                        ...prev,
                        transcripts: [...prev.transcripts, transcription],
                      }
                    : null,
                )
              }
            }
          })

          setProcessedRequestIds((prev) => new Set([...prev, request.uuid]))
        } catch (parseError) {
          console.error("[v0] Failed to parse request:", parseError)
          continue
        }
      }

      if (newTranscriptions.length > 0) {
        setTranscriptions((prevTranscriptions) => {
          const existingTexts = new Set(prevTranscriptions.map((t) => `${t.text}-${t.start}-${t.end}-${t.timestamp}`))
          const uniqueNewTranscriptions = newTranscriptions.filter(
            (t) => !existingTexts.has(`${t.text}-${t.start}-${t.end}-${t.timestamp}`),
          )

          if (uniqueNewTranscriptions.length === 0) {
            return prevTranscriptions
          }

          const combined = [...uniqueNewTranscriptions, ...prevTranscriptions]
          combined.sort((a, b) => {
            const timeA = new Date(a.timestamp || 0).getTime()
            const timeB = new Date(b.timestamp || 0).getTime()
            return timeB - timeA
          })

          addDebugInfo(`✅ Added ${uniqueNewTranscriptions.length} new transcriptions`)
          return combined
        })
      }

      setLastUpdate(new Date())
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error"

      if (errorMessage.includes("Too Many Requests")) {
        backoffRef.current = Math.min(backoffRef.current * 2 || 2000, 30000)
        setBackoffDelay(backoffRef.current)
        addDebugInfo(`⏳ Rate limited - backing off for ${backoffRef.current / 1000}s`)
        return
      }

      addDebugInfo(`❌ Fetch error: ${errorMessage}`)
      console.error("[v0] Fetch error:", error)
    } finally {
      setIsLoading(false)
    }
  }

  const startMonitoring = async () => {
    setIsMonitoring(true)
    addDebugInfo("▶️ Started monitoring")

    setLastAudioBytesRequestId(null)
    console.log("[v0] Starting monitoring - will establish baseline on first check")
    addDebugInfo("📍 Starting fresh monitoring - will establish baseline on first check")

    fetchTranscriptions()
    intervalRef.current = setInterval(fetchTranscriptions, pollingInterval)
  }

  const stopMonitoring = () => {
    setIsMonitoring(false)
    addDebugInfo("⏹️ Stopped monitoring")
    if (intervalRef.current) {
      clearInterval(intervalRef.current)
      intervalRef.current = null
    }
  }

  const exportTranscriptions = () => {
    const dataStr = JSON.stringify(transcriptions, null, 2)
    const dataBlob = new Blob([dataStr], { type: "application/json" })
    const url = URL.createObjectURL(dataBlob)
    const link = document.createElement("a")
    link.href = url
    link.download = `transcriptions-${new Date().toISOString().split("T")[0]}.json`
    link.click()
    URL.revokeObjectURL(url)
    addDebugInfo("📥 Exported transcriptions to JSON")
  }

  const resetRequestTracking = () => {
    setProcessedRequestIds(new Set())
    setProcessedSegmentIds(new Set())
    setLastAudioBytesRequestId(null)
    processedRequestIdsRef.current = new Set()
    processedSegmentIdsRef.current = new Set()
    lastNewAudioBytesTime.current = null
    localStorage.removeItem("transcription-processed-requests")
    localStorage.removeItem("transcription-processed-segments")
    addDebugInfo("🗑️ Cleared all processed request cache - will fetch fresh data")

    if (isMonitoring) {
      setTimeout(() => {
        fetchTranscriptions()
      }, 500)
    }
  }

  const filteredTranscriptions = transcriptions.filter(
    (t) =>
      t.text.toLowerCase().includes(searchTerm.toLowerCase()) ||
      t.speaker.toLowerCase().includes(searchTerm.toLowerCase()),
  )

  useEffect(() => {
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current)
      }
      if (audioTimeoutRef.current) {
        clearTimeout(audioTimeoutRef.current)
      }
    }
  }, [])

  useEffect(() => {
    if (isMonitoring && intervalRef.current) {
      clearInterval(intervalRef.current)
      intervalRef.current = setInterval(fetchTranscriptions, pollingInterval)
    }
  }, [pollingInterval])

  return (
    <div className="min-h-screen bg-background p-4">
      <div className="max-w-6xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Mic className="h-8 w-8 text-primary" />
            <h1 className="text-3xl font-bold text-balance">Omi Transcription Monitor</h1>
            <Badge variant="outline" className="text-green-600 border-green-300">
              ALWAYS MONITORING
            </Badge>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setSettingsOpen(!settingsOpen)}>
              <Settings className="h-4 w-4" />
            </Button>
            <Button variant="outline" size="sm" onClick={exportTranscriptions} disabled={transcriptions.length === 0}>
              <Download className="h-4 w-4" />
            </Button>
            <Button variant="outline" size="sm" onClick={resetRequestTracking}>
              Reset Tracking
            </Button>
          </div>
        </div>

        {hasRecentAudioBytes && (
          <Card className="border-red-500 bg-red-50 shadow-lg">
            <CardContent className="py-6">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="flex items-center gap-2">
                    <Circle className="h-4 w-4 fill-red-500 text-red-500 animate-pulse" />
                    <span className="font-bold text-red-700 text-lg">🔴 RECORDING IN PROGRESS</span>
                  </div>
                  <Badge variant="secondary" className="bg-red-100 text-red-800">
                    Audio bytes detected
                  </Badge>
                </div>
                <div className="text-sm text-red-600 font-medium">Live audio activity detected</div>
              </div>
            </CardContent>
          </Card>
        )}

        <Collapsible open={settingsOpen} onOpenChange={setSettingsOpen}>
          <CollapsibleContent>
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Settings className="h-5 w-5" />
                  Dual Webhook Settings
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="transcription-webhook-url">Transcription Webhook URL</Label>
                  <Input
                    id="transcription-webhook-url"
                    value={transcriptionWebhookUrl}
                    onChange={(e) => setTranscriptionWebhookUrl(e.target.value)}
                    placeholder="https://webhook.site/token/[token]/requests"
                  />
                  <p className="text-xs text-muted-foreground">
                    Receives live transcription updates every second during recording
                  </p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="audio-bytes-webhook-url">Audio Bytes Webhook URL</Label>
                  <Input
                    id="audio-bytes-webhook-url"
                    value={audioBytesWebhookUrl}
                    onChange={(e) => setAudioBytesWebhookUrl(e.target.value)}
                    placeholder="https://webhook.site/token/[token]/requests"
                  />
                  <p className="text-xs text-muted-foreground">Detects recording start/stop events from audio bytes</p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="api-key" className="flex items-center gap-2">
                    API Key
                    <Badge variant="destructive" className="text-xs">
                      Required
                    </Badge>
                  </Label>
                  <Input
                    id="api-key"
                    type="password"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder="Enter your webhook.site API key"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="polling-interval">Polling Interval (ms)</Label>
                  <Input
                    id="polling-interval"
                    type="number"
                    value={pollingInterval}
                    onChange={(e) => setPollingInterval(Number(e.target.value))}
                    min="2000"
                    step="1000"
                  />
                  <p className="text-xs text-muted-foreground">Recommended: 5000ms or higher to avoid rate limiting</p>
                </div>
              </CardContent>
            </Card>
          </CollapsibleContent>
        </Collapsible>

        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            {!isMonitoring ? (
              <Button onClick={startMonitoring} className="flex items-center gap-2">
                <Play className="h-4 w-4" />
                Start Monitoring
              </Button>
            ) : (
              <Button onClick={stopMonitoring} variant="destructive" className="flex items-center gap-2">
                <Pause className="h-4 w-4" />
                Stop Monitoring
              </Button>
            )}
            <Button
              variant="outline"
              onClick={fetchTranscriptions}
              disabled={isLoading}
              className="flex items-center gap-2 bg-transparent"
            >
              <RefreshCw className={`h-4 w-4 ${isLoading ? "animate-spin" : ""}`} />
              Refresh
            </Button>

            {backoffDelay > 0 && (
              <Badge variant="outline" className="text-orange-600 border-orange-300">
                Rate limited - backing off {backoffDelay / 1000}s
              </Badge>
            )}
          </div>

          <div className="flex items-center gap-3 text-sm text-muted-foreground">
            <div className="flex items-center gap-2">
              <div className={`w-2 h-2 rounded-full ${isMonitoring ? "bg-green-500" : "bg-gray-400"}`} />
              {isMonitoring ? "Monitoring" : "Stopped"}
            </div>
            {hasRecentAudioBytes && (
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                Recording
              </div>
            )}
            {lastUpdate && (
              <div className="flex items-center gap-1">
                <Clock className="h-3 w-3" />
                {lastUpdate.toLocaleTimeString()}
              </div>
            )}
          </div>
        </div>

        {conversations.length > 0 && (
          <div className="space-y-4">
            <h2 className="text-xl font-semibold">Completed Conversations ({conversations.length})</h2>
            <div className="grid gap-4">
              {conversations.slice(0, 3).map((conversation) => (
                <Card key={conversation.id} className="border-green-200">
                  <CardHeader className="pb-3">
                    <div className="flex items-center justify-between">
                      <CardTitle className="text-sm font-medium">Conversation {conversation.id}</CardTitle>
                      <Badge variant="outline" className="text-green-700 border-green-300">
                        {conversation.transcripts.length} segments
                      </Badge>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {conversation.startTime.toLocaleString()} - {conversation.endTime?.toLocaleString()}
                    </div>
                  </CardHeader>
                  <CardContent className="pt-0">
                    <div className="space-y-2 max-h-32 overflow-y-auto">
                      {conversation.transcripts.slice(0, 3).map((transcript, idx) => (
                        <div key={idx} className="text-sm">
                          <span className="font-medium text-muted-foreground">{transcript.speaker}:</span>{" "}
                          {transcript.text}
                        </div>
                      ))}
                      {conversation.transcripts.length > 3 && (
                        <div className="text-xs text-muted-foreground">
                          +{conversation.transcripts.length - 3} more segments...
                        </div>
                      )}
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>
        )}

        <div className="relative">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search transcriptions..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="pl-10"
          />
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Debug Information</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-1 text-xs font-mono">
              {debugInfo.length === 0 ? (
                <p className="text-muted-foreground">No debug information yet...</p>
              ) : (
                debugInfo.map((info, index) => (
                  <div key={index} className="text-muted-foreground">
                    {info}
                  </div>
                ))
              )}
            </div>
          </CardContent>
        </Card>

        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-xl font-semibold">All Transcriptions ({filteredTranscriptions.length})</h2>
          </div>

          {filteredTranscriptions.length === 0 ? (
            <Card>
              <CardContent className="py-8 text-center text-muted-foreground">
                {transcriptions.length === 0 ? (
                  <div className="space-y-2">
                    <Mic className="h-12 w-12 mx-auto opacity-50" />
                    <p>No transcriptions yet. Start monitoring to see live data from Omi.</p>
                    <p className="text-sm">
                      The system will automatically detect recording sessions and capture transcripts.
                    </p>
                  </div>
                ) : (
                  <p>No transcriptions match your search.</p>
                )}
              </CardContent>
            </Card>
          ) : (
            <div className="grid gap-4">
              {filteredTranscriptions.map((transcription, index) => (
                <Card key={index}>
                  <CardContent className="pt-4">
                    <div className="space-y-3">
                      <div className="flex items-start justify-between">
                        <div className="flex items-center gap-2">
                          <User className="h-4 w-4 text-muted-foreground" />
                          <span className="font-medium">{transcription.speaker}</span>
                          {transcription.confidence && (
                            <Badge variant="secondary" className="text-xs">
                              {Math.round(transcription.confidence * 100)}%
                            </Badge>
                          )}
                        </div>
                        <div className="flex gap-1">
                          {transcription.source && (
                            <Badge variant="outline" className="text-xs">
                              {transcription.source}
                            </Badge>
                          )}
                          {transcription.language && (
                            <Badge variant="outline" className="text-xs">
                              <Globe className="h-3 w-3 mr-1" />
                              {transcription.language}
                            </Badge>
                          )}
                        </div>
                      </div>

                      <p className="text-foreground leading-relaxed">{transcription.text}</p>

                      <div className="flex items-center gap-4 text-xs text-muted-foreground">
                        <div className="flex items-center gap-1">
                          <Clock className="h-3 w-3" />
                          {transcription.start}s - {transcription.end}s
                        </div>
                        {transcription.timestamp && <div>{new Date(transcription.timestamp).toLocaleString()}</div>}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
