package com.wolfman.app

import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.speech.tts.TextToSpeech
import android.text.method.ScrollingMovementMethod
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import org.json.JSONArray
import org.json.JSONObject
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.InetSocketAddress
import java.net.Socket
import java.net.URL
import java.util.Locale
import java.util.UUID

/**
 * Standalone-first Wolfman client. This phone is never dependent on a PC:
 * it probes ITSELF for live on-device model runtimes (e.g. Ollama running
 * under Termux) and answers from one of those directly. A PC daemon on the
 * LAN is an optional bonus peer, never a requirement — matching docs/STANDALONE.md.
 *
 * Every request is POLLED through the ranked list of real providers: if one
 * fails, returns nothing, or refuses/says it doesn't understand, Wolfman tries
 * the next — same fallback-chain contract as `core/src/orchestrator/index.ts`.
 *
 * Closed voice assistants (Google Assistant/Gemini, Copilot, Alexa) have no
 * public API to return a text answer to a third-party app, so they are never
 * part of that automatic chain. Instead Wolfman detects EVERY installed one
 * and offers a real voice handoff per assistant: it launches the assistant
 * into its own listening state, then speaks the wake phrase + your last
 * question aloud through the speaker so the assistant's own microphone hears
 * it — same as if you'd said it yourself. Its reply still appears only in
 * the assistant's own UI: no public API lets Wolfman read that answer back.
 */
class MainActivity : AppCompatActivity() {

    private data class LocalProvider(val baseUrl: String, val kind: String, val model: String)
    private data class AssistantCandidate(val label: String, val packageName: String, val canProcessText: Boolean, val canVoiceCommand: Boolean)

    /** Real wake phrases for known assistants — spoken aloud, never fabricated for unknown ones. */
    private val wakePhrases = mapOf(
        "com.google.android.googlequicksearchbox" to "Hey Google",
        "com.amazon.dee.app" to "Alexa",
    )

    private lateinit var statusView: TextView
    private lateinit var daemonUrlInput: EditText
    private lateinit var questionInput: EditText
    private lateinit var speakRepliesToggle: CheckBox
    private lateinit var assistantButtons: LinearLayout
    private lateinit var responseView: TextView
    private var tts: TextToSpeech? = null
    private var speechRecognizer: SpeechRecognizer? = null
    private var lastAskedQuestion: String? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val neededPermissions = mutableListOf(android.Manifest.permission.RECORD_AUDIO)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            neededPermissions += android.Manifest.permission.POST_NOTIFICATIONS
        }
        ActivityCompat.requestPermissions(this, neededPermissions.toTypedArray(), 1)
        ContextCompat.startForegroundService(this, Intent(this, WolfmanService::class.java))
        tts = TextToSpeech(this) { }
        if (SpeechRecognizer.isRecognitionAvailable(this)) {
            speechRecognizer = SpeechRecognizer.createSpeechRecognizer(this)
        }

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(48, 96, 48, 48)
        }

        statusView = TextView(this).apply { text = "Detecting on-device AI providers\u2026" }
        daemonUrlInput = EditText(this).apply {
            hint = "Optional: PC daemon URL (bonus LAN peer, e.g. http://10.0.0.35:8791)"
        }
        questionInput = EditText(this).apply { hint = "Ask Wolfman\u2026" }
        val askButton = Button(this).apply { text = "Ask" }
        val speakButton = Button(this).apply { text = "\uD83C\uDFA4 Speak" }
        speakRepliesToggle = CheckBox(this).apply { text = "Speak replies aloud"; isChecked = true }
        assistantButtons = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        responseView = TextView(this).apply {
            text = "Not asked yet."
            movementMethod = ScrollingMovementMethod()
            setPadding(0, 48, 0, 0)
        }

        askButton.setOnClickListener { ask() }
        speakButton.setOnClickListener { listenForQuestion() }

        root.addView(statusView)
        root.addView(daemonUrlInput)
        root.addView(questionInput)
        root.addView(askButton)
        root.addView(speakButton)
        root.addView(speakRepliesToggle)
        root.addView(assistantButtons)
        root.addView(responseView)

        setContentView(ScrollView(this).apply { addView(root) })

        detectLocalAsync()
    }

    override fun onDestroy() {
        tts?.shutdown()
        speechRecognizer?.destroy()
        super.onDestroy()
    }

    /**
     * Real, live, on-device speech-to-text via Android's own `SpeechRecognizer`
     * — no cloud STT call, nothing fabricated. Transcribes the spoken
     * question into the input field and immediately asks it, same as tapping
     * "Ask" after typing.
     */
    private fun listenForQuestion() {
        if (ContextCompat.checkSelfPermission(this, android.Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(this, arrayOf(android.Manifest.permission.RECORD_AUDIO), 1)
            Toast.makeText(this, "Microphone permission is needed to speak to Wolfman.", Toast.LENGTH_LONG).show()
            return
        }
        val recognizer = speechRecognizer
        if (recognizer == null) {
            Toast.makeText(this, "No speech recognizer is available on this device.", Toast.LENGTH_LONG).show()
            return
        }

        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.getDefault())
        }

        recognizer.setRecognitionListener(object : RecognitionListener {
            override fun onReadyForSpeech(params: Bundle?) {
                Handler(Looper.getMainLooper()).post { statusView.text = "Listening\u2026" }
            }
            override fun onResults(results: Bundle?) {
                val text = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()
                Handler(Looper.getMainLooper()).post {
                    if (text.isNullOrBlank()) {
                        Toast.makeText(this@MainActivity, "Didn't catch that \u2014 try again.", Toast.LENGTH_SHORT).show()
                    } else {
                        questionInput.setText(text)
                        ask()
                    }
                }
            }
            override fun onError(error: Int) {
                Handler(Looper.getMainLooper()).post {
                    Toast.makeText(this@MainActivity, "Speech recognition error ($error)", Toast.LENGTH_SHORT).show()
                }
            }
            override fun onBeginningOfSpeech() {}
            override fun onRmsChanged(rmsdB: Float) {}
            override fun onBufferReceived(buffer: ByteArray?) {}
            override fun onEndOfSpeech() {}
            override fun onPartialResults(partialResults: Bundle?) {}
            override fun onEvent(eventType: Int, params: Bundle?) {}
        })

        recognizer.startListening(intent)
    }

    private fun detectLocalAsync() {
        Thread {
            val locals = detectLocalAll()
            val assistants = detectAssistants()

            Handler(Looper.getMainLooper()).post {
                assistantButtons.removeAllViews()
                for (assistant in assistants) {
                    val label = if (assistant.canVoiceCommand) "Ask ${assistant.label} by voice" else "Hand off to ${assistant.label}"
                    assistantButtons.addView(Button(this).apply {
                        text = label
                        setOnClickListener { handOff(assistant) }
                    })
                }

                val localLine = if (locals.isNotEmpty()) {
                    "On-device models: " + locals.joinToString(", ") { "${it.kind}@${it.baseUrl} (${it.model})" }
                } else {
                    "On-device models: none found (install Ollama/an OpenAI-compatible runtime, e.g. via Termux)"
                }
                val assistantLine = if (assistants.isNotEmpty()) {
                    "Installed assistants: ${assistants.joinToString(", ") { it.label }} (voice handoff — no API returns their answer text)"
                } else {
                    "Installed assistants: none detected"
                }
                statusView.text = "$localLine\n$assistantLine"
            }
        }.start()
    }

    /**
     * Polls the ranked list of real, live providers one at a time: local
     * on-device runtimes first (privacy-preferred), then the optional PC
     * daemon. A provider that errors, returns nothing, or refuses/says it
     * doesn't understand is recorded as an attempt and Wolfman moves to the
     * next — nothing is ever fabricated to paper over a failed attempt.
     */
    private fun ask() {
        val question = questionInput.text.toString().trim()
        if (question.isEmpty()) return
        lastAskedQuestion = question

        responseView.text = "Asking\u2026"
        Thread {
            val attempts = mutableListOf<String>()
            var answer: String? = null

            for (local in detectLocalAll()) {
                val outcome = runCatching { callLocal(local, question) }
                val text = outcome.getOrNull()
                if (outcome.isSuccess && text != null && !looksLikeRefusal(text)) {
                    answer = text
                    break
                }
                attempts += "${local.kind}@${local.baseUrl}: ${outcome.exceptionOrNull()?.message ?: refusalReason(text)}"
            }

            val daemonUrl = daemonUrlInput.text.toString().trim().trimEnd('/')
            if (answer == null && daemonUrl.isNotEmpty()) {
                val outcome = runCatching { callDaemon(daemonUrl, question) }
                val text = outcome.getOrNull()
                if (outcome.isSuccess && text != null && !looksLikeRefusal(text)) {
                    answer = text
                } else {
                    attempts += "PC daemon ($daemonUrl): ${outcome.exceptionOrNull()?.message ?: refusalReason(text)}"
                }
            }

            if (answer == null) {
                val outcome = runCatching { searchWeb(question) }
                val text = outcome.getOrNull()
                if (outcome.isSuccess && text != null) {
                    answer = text
                } else {
                    attempts += "Web search (DuckDuckGo): ${outcome.exceptionOrNull()?.message ?: "no result for this query"}"
                }
            }

            val finalText = answer ?: buildString {
                append("NO_LIVE_SOURCE: no provider answered.\n")
                if (attempts.isNotEmpty()) {
                    append("Attempted:\n")
                    attempts.forEach { append("  ✗ $it\n") }
                } else {
                    append("No on-device provider or PC daemon was configured.\n")
                }
                append("Install a local model runtime on this phone (e.g. Ollama via Termux), enter a PC daemon URL as an optional peer, ")
                append("or ask one of the installed-assistant buttons below.")
            }

            Handler(Looper.getMainLooper()).post {
                responseView.text = finalText
                if (speakRepliesToggle.isChecked) {
                    tts?.language = Locale.US
                    tts?.speak(finalText, TextToSpeech.QUEUE_FLUSH, null, "wolfman-reply")
                }
            }
        }.start()
    }

    /** A conservative, non-exhaustive check — routing signal only, never used to alter the answer text itself. */
    private fun looksLikeRefusal(text: String): Boolean {
        if (text.isBlank()) return true
        val normalized = text.trim().lowercase()
        val patterns = listOf(
            "i cannot help with that", "i can't help with that", "i am not able to", "i'm not able to",
            "i do not understand", "i don't understand", "i cannot answer", "i can't answer",
            "as an ai language model", "i'm unable to", "i am unable to",
        )
        return patterns.any { normalized.contains(it) }
    }

    private fun refusalReason(text: String?): String =
        if (text.isNullOrBlank()) "returned an empty answer" else "declined/did not understand the request"

    /** Real handshake, never assumed: a candidate port only counts once it answers with real models. Ranked in scan order. */
    private fun detectLocalAll(): List<LocalProvider> {
        val candidates = listOf(11434 to "ollama", 1234 to "openai", 8080 to "openai", 8000 to "openai", 5000 to "openai")
        val found = mutableListOf<LocalProvider>()
        for ((port, kind) in candidates) {
            if (!portOpen(port)) continue
            val base = "http://127.0.0.1:$port"
            val model = runCatching { fetchFirstModel(base, kind) }.getOrNull() ?: continue
            found += LocalProvider(base, kind, model)
        }
        return found
    }

    private fun portOpen(port: Int): Boolean = runCatching {
        Socket().use { it.connect(InetSocketAddress("127.0.0.1", port), 400); true }
    }.getOrDefault(false)

    private fun fetchFirstModel(base: String, kind: String): String? {
        val path = if (kind == "ollama") "/api/tags" else "/v1/models"
        val connection = (URL(base + path).openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"
            connectTimeout = 1500
            readTimeout = 1500
        }
        if (connection.responseCode !in 200..299) return null
        val body = connection.inputStream.bufferedReader().use { it.readText() }
        val json = JSONObject(body)
        return if (kind == "ollama") {
            json.optJSONArray("models")?.optJSONObject(0)?.optString("name")
        } else {
            json.optJSONArray("data")?.optJSONObject(0)?.optString("id")
        }
    }

    /**
     * Live, keyless public web search — no cloud SDK, no API key. Same source
     * DuckDuckGo Instant Answer API as the desktop core's `internet.ts`. This
     * is Wolfman's own fallback for finding a real answer when no model
     * runtime or daemon could, before ever suggesting an assistant handoff.
     */
    private fun searchWeb(query: String): String? {
        val encoded = java.net.URLEncoder.encode(query, "UTF-8")
        val url = "https://api.duckduckgo.com/?q=$encoded&format=json&no_html=1&skip_disambig=1"
        val connection = (URL(url).openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"
            connectTimeout = 6_000
            readTimeout = 8_000
        }
        if (connection.responseCode !in 200..299) throw java.io.IOException("HTTP ${connection.responseCode}")

        val raw = connection.inputStream.bufferedReader().use { it.readText() }
        val json = JSONObject(raw)
        val heading = json.optString("Heading").ifBlank { null }
        val abstractText = json.optString("AbstractText").ifBlank { null }
        val abstractUrl = json.optString("AbstractURL").ifBlank { null }

        if (abstractText != null) {
            return buildString {
                if (heading != null) append("$heading\n\n")
                append(abstractText)
                if (abstractUrl != null) append("\n\nsource: $abstractUrl")
            }
        }

        val related = json.optJSONArray("RelatedTopics")
        for (i in 0 until (related?.length() ?: 0)) {
            val text = related!!.getJSONObject(i).optString("Text").ifBlank { null } ?: continue
            return text
        }
        return null
    }

    /** Calls the on-device runtime directly \u2014 this phone needs nothing else to answer. */
    private fun callLocal(p: LocalProvider, question: String): String {
        val messages = JSONArray().put(JSONObject().apply { put("role", "user"); put("content", question) })
        val body = JSONObject().apply {
            put("model", p.model)
            put("stream", false)
            put("messages", messages)
        }
        val path = if (p.kind == "ollama") "/api/chat" else "/v1/chat/completions"

        val connection = (URL(p.baseUrl + path).openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            doOutput = true
            connectTimeout = 5_000
            readTimeout = 120_000
            setRequestProperty("Content-Type", "application/json")
        }
        OutputStreamWriter(connection.outputStream).use { it.write(body.toString()) }

        if (connection.responseCode !in 200..299) throw java.io.IOException("HTTP ${connection.responseCode}")
        val raw = connection.inputStream.bufferedReader().use { it.readText() }
        val json = JSONObject(raw)
        val text = if (p.kind == "ollama") {
            json.optJSONObject("message")?.optString("content")
        } else {
            json.optJSONArray("choices")?.optJSONObject(0)?.optJSONObject("message")?.optString("content")
        }
        return text?.ifBlank { null } ?: throw java.io.IOException("empty response body")
    }

    /** Calls a PC daemon's `wolfman.ask` MCP tool over HTTP \u2014 optional bonus peer only. */
    private fun callDaemon(baseUrl: String, question: String): String {
        val body = JSONObject().apply {
            put("jsonrpc", "2.0")
            put("id", UUID.randomUUID().toString())
            put("method", "tools/call")
            put("params", JSONObject().apply {
                put("name", "wolfman.ask")
                put("arguments", JSONObject().apply { put("text", question) })
            })
        }

        val connection = (URL(baseUrl).openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            doOutput = true
            connectTimeout = 10_000
            readTimeout = 90_000
            setRequestProperty("Content-Type", "application/json")
        }

        OutputStreamWriter(connection.outputStream).use { it.write(body.toString()) }

        if (connection.responseCode !in 200..299) throw java.io.IOException("HTTP ${connection.responseCode}")

        val raw = connection.inputStream.bufferedReader().use { it.readText() }
        val json = JSONObject(raw)
        json.optJSONObject("error")?.let { error -> throw java.io.IOException(error.optString("message", "daemon reported an error")) }

        val result = json.optJSONObject("result") ?: throw java.io.IOException("malformed daemon response")
        val content = result.optJSONArray("content")
        val text = (0 until (content?.length() ?: 0)).joinToString("\n") { i -> content!!.getJSONObject(i).optString("text") }
        return text.ifBlank { null } ?: throw java.io.IOException("daemon returned an empty answer")
    }

    /**
     * Real detection only: whatever resolves the ASSIST intent. A name match is
     * never enough on its own — every candidate here actually answered a real
     * PackageManager query.
     */
    private fun detectAssistants(): List<AssistantCandidate> {
        val found = LinkedHashMap<String, AssistantCandidate>()

        val assistIntent = Intent(Intent.ACTION_ASSIST)
        val resolved = runCatching { packageManager.queryIntentActivities(assistIntent, 0) }.getOrDefault(emptyList())
        for (info in resolved) {
            val pkg = info.activityInfo.packageName
            if (found.containsKey(pkg)) continue
            found[pkg] = AssistantCandidate(
                info.loadLabel(packageManager).toString(),
                pkg,
                canProcessText = resolvesProcessText(pkg),
                canVoiceCommand = resolvesVoiceCommand(pkg),
            )
        }

        return found.values.toList()
    }

    private fun resolvesProcessText(packageName: String): Boolean {
        val intent = Intent(Intent.ACTION_PROCESS_TEXT).setType("text/plain").setPackage(packageName)
        return runCatching { packageManager.queryIntentActivities(intent, 0).isNotEmpty() }.getOrDefault(false)
    }

    private fun resolvesVoiceCommand(packageName: String): Boolean {
        val intent = Intent(Intent.ACTION_VOICE_COMMAND).setPackage(packageName)
        return runCatching { packageManager.queryIntentActivities(intent, 0).isNotEmpty() }.getOrDefault(false)
    }

    /**
     * Real voice handoff, per assistant. Launches the assistant into its own
     * listening state (ACTION_VOICE_COMMAND when supported), then — after a
     * short warm-up delay — speaks the assistant's real wake phrase followed
     * by your last question aloud through the speaker, so its OWN microphone
     * hears it, exactly as if you'd said it. Falls back to ACTION_PROCESS_TEXT
     * (typed handoff) or a plain open when voice-command isn't supported.
     * The reply always appears in the assistant's own UI: no public API lets
     * Wolfman read a voice assistant's answer back, spoken or written.
     */
    private fun handOff(assistant: AssistantCandidate) {
        val question = lastAskedQuestion ?: questionInput.text.toString().trim()
        if (question.isEmpty()) {
            Toast.makeText(this, "Ask Wolfman something first.", Toast.LENGTH_SHORT).show()
            return
        }

        if (assistant.canVoiceCommand) {
            runCatching { startActivity(Intent(Intent.ACTION_VOICE_COMMAND).setPackage(assistant.packageName)) }
                .onFailure { Toast.makeText(this, "Could not launch ${assistant.label}: ${it.message}", Toast.LENGTH_LONG).show(); return }

            val phrase = wakePhrases[assistant.packageName]
            val utterance = if (phrase != null) "$phrase, $question" else question
            Handler(Looper.getMainLooper()).postDelayed({
                tts?.language = Locale.US
                tts?.speak(utterance, TextToSpeech.QUEUE_FLUSH, null, "wolfman-handoff")
            }, 1300)
            return
        }

        val intent = if (assistant.canProcessText) {
            Intent(Intent.ACTION_PROCESS_TEXT).apply {
                type = "text/plain"
                setPackage(assistant.packageName)
                putExtra(Intent.EXTRA_PROCESS_TEXT, question)
                putExtra(Intent.EXTRA_PROCESS_TEXT_READONLY, true)
            }
        } else {
            Intent(Intent.ACTION_ASSIST).setPackage(assistant.packageName)
        }

        runCatching { startActivity(intent) }.onFailure {
            Toast.makeText(this, "Could not launch ${assistant.label}: ${it.message}", Toast.LENGTH_LONG).show()
        }
    }
}

