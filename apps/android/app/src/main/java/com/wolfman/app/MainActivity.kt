package com.wolfman.app

import android.content.Intent
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.media.AudioManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.text.method.ScrollingMovementMethod
import android.util.Log
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
import com.microsoft.identity.client.AcquireTokenSilentParameters
import com.microsoft.identity.client.AuthenticationCallback
import com.microsoft.identity.client.IAccount
import com.microsoft.identity.client.IAuthenticationResult
import com.microsoft.identity.client.IPublicClientApplication
import com.microsoft.identity.client.ISingleAccountPublicClientApplication
import com.microsoft.identity.client.PublicClientApplication
import com.microsoft.identity.client.SignInParameters
import com.microsoft.identity.client.SilentAuthenticationCallback
import com.microsoft.identity.client.exception.MsalException
import org.json.JSONArray
import org.json.JSONObject
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.InetSocketAddress
import java.net.Socket
import java.net.URL
import java.util.Locale
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

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

    private companion object {
        const val TAG = "Wolfman"
        const val AZURE_MCP_URL = "https://wolfman-mcp.azurewebsites.net/"
        const val AZURE_MCP_SCOPE = "api://20ed062d-2af7-4554-a27c-ce9e7bf367f2/access_as_user"
    }

    private data class LocalProvider(val baseUrl: String, val kind: String, val model: String)
    private data class AssistantCandidate(val label: String, val packageName: String, val canProcessText: Boolean, val canVoiceCommand: Boolean)

    /** Real wake phrases for known assistants — spoken aloud, never fabricated for unknown ones. */
    private val wakePhrases = mapOf(
        "com.google.android.googlequicksearchbox" to "Hey Google",
        "com.amazon.dee.app" to "Alexa",
    )

    private lateinit var statusView: TextView
    private lateinit var questionInput: EditText
    private lateinit var speakRepliesToggle: CheckBox
    private lateinit var autoListenToggle: CheckBox
    private lateinit var azureSignInButton: Button
    private lateinit var assistantButtons: LinearLayout
    private lateinit var responseView: TextView
    private var tts: TextToSpeech? = null
    private var speechRecognizer: SpeechRecognizer? = null
    private var lastAskedQuestion: String? = null
    private var pendingHandoffQuestion: String? = null
    private var msalApp: ISingleAccountPublicClientApplication? = null
    private var azureAccessToken: String? = null
    private val conversationHistory = mutableListOf<Pair<String, String>>()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val neededPermissions = mutableListOf(android.Manifest.permission.RECORD_AUDIO)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            neededPermissions += android.Manifest.permission.POST_NOTIFICATIONS
        }
        ActivityCompat.requestPermissions(this, neededPermissions.toTypedArray(), 1)
        ContextCompat.startForegroundService(this, Intent(this, WolfmanService::class.java))
        tts = TextToSpeech(this) { }
        tts?.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
            override fun onStart(utteranceId: String?) {}
            override fun onDone(utteranceId: String?) {
                Handler(Looper.getMainLooper()).post { onTtsFinished(utteranceId) }
            }
            @Deprecated("Deprecated in Java")
            override fun onError(utteranceId: String?) {
                Handler(Looper.getMainLooper()).post { onTtsFinished(utteranceId) }
            }
        })
        if (SpeechRecognizer.isRecognitionAvailable(this)) {
            speechRecognizer = SpeechRecognizer.createSpeechRecognizer(this)
        }
        initAzureSignIn()

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(48, 96, 48, 48)
        }

        statusView = TextView(this).apply { text = "Detecting on-device AI providers\u2026" }
        questionInput = EditText(this).apply { hint = "Ask Wolfman\u2026" }
        val askButton = Button(this).apply { text = "Ask" }
        val speakButton = Button(this).apply { text = "\uD83C\uDFA4 Speak" }
        speakRepliesToggle = CheckBox(this).apply { text = "Speak replies aloud"; isChecked = true }
        autoListenToggle = CheckBox(this).apply { text = "\uD83D\uDD34 Auto-listen (no tap needed)" }
        azureSignInButton = Button(this).apply { text = "Sign in to Azure" }
        val teachButton = Button(this).apply { text = "\uD83D\uDCDA Teach Wolfman (listen)" }
        assistantButtons = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        responseView = TextView(this).apply {
            text = "Not asked yet."
            movementMethod = ScrollingMovementMethod()
            setPadding(0, 48, 0, 0)
        }

        askButton.setOnClickListener { ask() }
        speakButton.setOnClickListener { listenForQuestion() }
        azureSignInButton.setOnClickListener { signInToAzure() }
        teachButton.setOnClickListener { promptTeachWolfman() }
        autoListenToggle.setOnCheckedChangeListener { _, checked ->
            Log.d(TAG, "autoListenToggle checked=$checked")
            if (checked) listenForQuestion()
        }

        root.addView(statusView)
        root.addView(questionInput)
        root.addView(askButton)
        root.addView(speakButton)
        root.addView(speakRepliesToggle)
        root.addView(autoListenToggle)
        root.addView(azureSignInButton)
        root.addView(teachButton)
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
     * "Ask" after typing. When "Auto-listen" is checked, restarts itself
     * after each utterance so you never have to tap Speak again — except
     * while handing off to Google/Alexa, when it must stay off the mic.
     */
    private fun listenForQuestion() {
        Log.d(TAG, "listenForQuestion() called")
        if (ContextCompat.checkSelfPermission(this, android.Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            Log.d(TAG, "listenForQuestion: RECORD_AUDIO not granted")
            ActivityCompat.requestPermissions(this, arrayOf(android.Manifest.permission.RECORD_AUDIO), 1)
            Toast.makeText(this, "Microphone permission is needed to speak to Wolfman.", Toast.LENGTH_LONG).show()
            return
        }
        val recognizer = speechRecognizer
        if (recognizer == null) {
            Log.d(TAG, "listenForQuestion: speechRecognizer is null (not available on this device)")
            Toast.makeText(this, "No speech recognizer is available on this device.", Toast.LENGTH_LONG).show()
            return
        }

        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.getDefault())
        }

        recognizer.setRecognitionListener(object : RecognitionListener {
            override fun onReadyForSpeech(params: Bundle?) {
                Log.d(TAG, "listenForQuestion: onReadyForSpeech")
                Handler(Looper.getMainLooper()).post { statusView.text = "Listening\u2026" }
            }
            override fun onResults(results: Bundle?) {
                val text = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()
                Log.d(TAG, "listenForQuestion: onResults text=$text")
                Handler(Looper.getMainLooper()).post {
                    if (text.isNullOrBlank()) {
                        Toast.makeText(this@MainActivity, "Didn't catch that \u2014 try again.", Toast.LENGTH_SHORT).show()
                        restartAutoListenIfEnabled()
                    } else {
                        questionInput.setText(text)
                        ask()
                        // If replies are spoken, restart happens after TTS finishes (see onCreate);
                        // otherwise there's no speaker output to avoid overhearing, so restart now.
                        if (!speakRepliesToggle.isChecked) restartAutoListenIfEnabled()
                    }
                }
            }
            override fun onError(error: Int) {
                Log.d(TAG, "listenForQuestion: onError code=$error")
                Handler(Looper.getMainLooper()).post {
                    Toast.makeText(this@MainActivity, "Speech recognition error ($error)", Toast.LENGTH_SHORT).show()
                    restartAutoListenIfEnabled()
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

    /** Restarts listening on its own after a pause long enough for the recognizer to fully reset (avoids ERROR_CLIENT from restarting too fast), only while Auto-listen stays checked. */
    private fun restartAutoListenIfEnabled() {
        Log.d(TAG, "restartAutoListenIfEnabled: autoListenToggle.isChecked=${autoListenToggle.isChecked}")
        if (!autoListenToggle.isChecked) return
        recreateSpeechRecognizer()
        Handler(Looper.getMainLooper()).postDelayed({ if (autoListenToggle.isChecked) listenForQuestion() }, 1800)
    }

    /** Destroys and recreates the recognizer — reusing one instance across rapid restarts is what causes repeated ERROR_CLIENT (5). */
    private fun recreateSpeechRecognizer() {
        speechRecognizer?.destroy()
        speechRecognizer = if (SpeechRecognizer.isRecognitionAvailable(this)) SpeechRecognizer.createSpeechRecognizer(this) else null
    }

    /**
     * Fires once Wolfman's own TTS actually finishes speaking (never on a
     * blind timer). For a normal reply, resumes Auto-listen. For a handoff,
     * only NOW \u2014 after Wolfman's own voice has gone silent \u2014 does it wait a
     * further buffer for the assistant to finish its own listening and begin
     * speaking, then starts listening for that spoken reply.
     */
    private fun onTtsFinished(utteranceId: String?) {
        Log.d(TAG, "onTtsFinished utteranceId=$utteranceId pendingHandoffQuestion=$pendingHandoffQuestion")
        when (utteranceId) {
            "wolfman-reply" -> restartAutoListenIfEnabled()
            "wolfman-handoff" -> {
                val question = pendingHandoffQuestion ?: return
                Handler(Looper.getMainLooper()).postDelayed({ listenForAssistantReply(question) }, 3500)
            }
        }
    }

    /** Loads the MSAL app once; restores a cached sign-in silently if one exists. */
    private fun initAzureSignIn() {
        PublicClientApplication.createSingleAccountPublicClientApplication(
            this,
            R.raw.msal_config,
            object : IPublicClientApplication.ISingleAccountApplicationCreatedListener {
                override fun onCreated(application: ISingleAccountPublicClientApplication) {
                    msalApp = application
                    application.getCurrentAccountAsync(object : ISingleAccountPublicClientApplication.CurrentAccountCallback {
                        override fun onAccountLoaded(activeAccount: IAccount?) {
                            if (activeAccount != null) acquireTokenSilent(activeAccount)
                        }
                        override fun onAccountChanged(priorAccount: IAccount?, currentAccount: IAccount?) {
                            azureAccessToken = null
                        }
                        override fun onError(exception: MsalException) {}
                    })
                }
                override fun onError(exception: MsalException) {
                    Handler(Looper.getMainLooper()).post {
                        Toast.makeText(this@MainActivity, "Azure sign-in unavailable: ${exception.message}", Toast.LENGTH_LONG).show()
                    }
                }
            },
        )
    }

    /** Interactive sign-in — needed once; afterwards tokens refresh silently. */
    private fun signInToAzure() {
        val app = msalApp
        if (app == null) {
            Toast.makeText(this, "Azure sign-in is still starting up — try again in a moment.", Toast.LENGTH_SHORT).show()
            return
        }
        app.signIn(
            SignInParameters.builder()
                .withActivity(this)
                .withScopes(listOf(AZURE_MCP_SCOPE))
                .withCallback(object : AuthenticationCallback {
                    override fun onSuccess(authenticationResult: IAuthenticationResult) {
                        azureAccessToken = authenticationResult.accessToken
                        Toast.makeText(this@MainActivity, "Signed in to Azure.", Toast.LENGTH_SHORT).show()
                    }
                    override fun onError(exception: MsalException) {
                        Toast.makeText(this@MainActivity, "Azure sign-in failed: ${exception.message}", Toast.LENGTH_LONG).show()
                    }
                    override fun onCancel() {
                        Toast.makeText(this@MainActivity, "Azure sign-in cancelled.", Toast.LENGTH_SHORT).show()
                    }
                })
                .build(),
        )
    }

    private fun acquireTokenSilent(account: IAccount) {
        val app = msalApp ?: return
        app.acquireTokenSilentAsync(
            AcquireTokenSilentParameters.Builder()
                .withScopes(listOf(AZURE_MCP_SCOPE))
                .forAccount(account)
                .fromAuthority(account.authority)
                .withCallback(object : SilentAuthenticationCallback {
                    override fun onSuccess(authenticationResult: IAuthenticationResult) {
                        azureAccessToken = authenticationResult.accessToken
                    }
                    override fun onError(exception: MsalException) {
                        azureAccessToken = null
                    }
                })
                .build(),
        )
    }

    /** Blocks (background thread only) for a fresh silent token before an Azure MCP call. */
    private fun freshAzureToken(): String? {
        val app = msalApp ?: return null
        val account = runCatching {
            val latch = CountDownLatch(1)
            var found: IAccount? = null
            app.getCurrentAccountAsync(object : ISingleAccountPublicClientApplication.CurrentAccountCallback {
                override fun onAccountLoaded(activeAccount: IAccount?) { found = activeAccount; latch.countDown() }
                override fun onAccountChanged(priorAccount: IAccount?, currentAccount: IAccount?) { found = currentAccount; latch.countDown() }
                override fun onError(exception: MsalException) { latch.countDown() }
            })
            latch.await(5, TimeUnit.SECONDS)
            found
        }.getOrNull() ?: return azureAccessToken

        val latch = CountDownLatch(1)
        var token = azureAccessToken
        app.acquireTokenSilentAsync(
            AcquireTokenSilentParameters.Builder()
                .withScopes(listOf(AZURE_MCP_SCOPE))
                .forAccount(account)
                .fromAuthority(account.authority)
                .withCallback(object : SilentAuthenticationCallback {
                    override fun onSuccess(authenticationResult: IAuthenticationResult) {
                        token = authenticationResult.accessToken
                        azureAccessToken = token
                        latch.countDown()
                    }
                    override fun onError(exception: MsalException) { latch.countDown() }
                })
                .build(),
        )
        latch.await(10, TimeUnit.SECONDS)
        return token
    }

    /**
     * Calls the hosted Wolfman MCP daemon (Azure OpenAI behind the App Service's
     * own managed identity) over its `wolfman.ask` tool, authenticated with a
     * real Entra ID bearer token. Same live-or-throw contract as `callLocal`.
     */
    private fun callAzureMcp(token: String, question: String): String {
        val body = JSONObject().apply {
            put("jsonrpc", "2.0")
            put("id", UUID.randomUUID().toString())
            put("method", "tools/call")
            put("params", JSONObject().apply {
                put("name", "wolfman.ask")
                put("arguments", JSONObject().apply { put("text", question) })
            })
        }

        val connection = (URL(AZURE_MCP_URL).openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            doOutput = true
            connectTimeout = 10_000
            readTimeout = 90_000
            setRequestProperty("Content-Type", "application/json")
            setRequestProperty("Authorization", "Bearer $token")
        }
        OutputStreamWriter(connection.outputStream).use { it.write(body.toString()) }

        if (connection.responseCode !in 200..299) throw java.io.IOException("HTTP ${connection.responseCode}")

        val raw = connection.inputStream.bufferedReader().use { it.readText() }
        val json = JSONObject(raw)
        json.optJSONObject("error")?.let { error -> throw java.io.IOException(error.optString("message", "Azure MCP reported an error")) }

        val result = json.optJSONObject("result") ?: throw java.io.IOException("malformed Azure MCP response")
        val content = result.optJSONArray("content")
        val text = (0 until (content?.length() ?: 0)).joinToString("\n") { i -> content!!.getJSONObject(i).optString("text") }
        return text.ifBlank { null } ?: throw java.io.IOException("Azure MCP returned an empty answer")
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

        // Carries the last few turns along so a short follow-up ("yes", "try that") lands
        // as a continuation of the same exchange instead of an unrelated new request.
        val questionWithContext = if (conversationHistory.isEmpty()) {
            question
        } else {
            buildString {
                append("Conversation so far:\n")
                conversationHistory.takeLast(4).forEach { (q, a) -> append("User: $q\nWolfman: $a\n") }
                append("\nUser's follow-up: $question")
            }
        }

        responseView.text = "Asking\u2026"
        Thread {
            val attempts = mutableListOf<String>()
            var answer: String? = null

            for (local in detectLocalAll()) {
                val outcome = runCatching { callLocal(local, questionWithContext) }
                val text = outcome.getOrNull()
                if (outcome.isSuccess && text != null && !looksLikeRefusal(text)) {
                    answer = text
                    break
                }
                attempts += "${local.kind}@${local.baseUrl}: ${outcome.exceptionOrNull()?.message ?: refusalReason(text)}"
            }

            if (answer == null) {
                val token = freshAzureToken()
                if (token != null) {
                    val outcome = runCatching { callAzureMcp(token, questionWithContext) }
                    val text = outcome.getOrNull()
                    if (outcome.isSuccess && text != null && !looksLikeRefusal(text)) {
                        answer = text
                    } else {
                        attempts += "Azure MCP: ${outcome.exceptionOrNull()?.message ?: refusalReason(text)}"
                    }
                } else {
                    attempts += "Azure MCP: not signed in (tap \"Sign in to Azure\")"
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

            if (answer != null) {
                conversationHistory += question to finalText
                while (conversationHistory.size > 4) conversationHistory.removeAt(0)
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
     * Real, live web search — DuckDuckGo's HTML result page (organic results),
     * not the weak Instant-Answer API, which only ever matched curated topic
     * summaries and missed most real questions. If Wolfman learning has a
     * source hint for a similar past question (see `recordLearning`), that
     * hint is added to the query first — Wolfman remembers WHERE an answer
     * was found before, never the answer itself, so the result here is
     * always fetched live.
     */
    private fun searchWeb(query: String): String? {
        val hint = findLearnedSource(query)
        if (hint != null) {
            val scoped = runCatching { htmlSearch("$query $hint") }.getOrNull()
            if (scoped != null) return scoped
        }
        return htmlSearch(query) ?: throw java.io.IOException("no live web results for this query")
    }

    private fun htmlSearch(query: String): String? {
        val encoded = java.net.URLEncoder.encode(query, "UTF-8")
        val connection = (URL("https://html.duckduckgo.com/html/?q=$encoded").openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"
            connectTimeout = 6_000
            readTimeout = 8_000
            setRequestProperty("User-Agent", "Mozilla/5.0 (compatible; WolfmanBot/1.0)")
        }
        if (connection.responseCode !in 200..299) throw java.io.IOException("HTTP ${connection.responseCode}")

        val html = connection.inputStream.bufferedReader().use { it.readText() }
        val re = Regex("""class="result__a"[^>]*>([\s\S]*?)</a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)</a>""")
        val results = re.findAll(html).take(4).map { m ->
            "${stripHtml(m.groupValues[1])}: ${stripHtml(m.groupValues[2])}"
        }.toList()
        return if (results.isEmpty()) null else results.joinToString("\n")
    }

    private fun stripHtml(s: String): String =
        s.replace(Regex("<[^>]+>"), "").replace("&amp;", "&").replace("&#x27;", "'").replace("&quot;", "\"").trim()

    /** Persisted as simple JSON in SharedPreferences — (keywords, hint) pairs only, never answer text. */
    private fun learningPrefs(): SharedPreferences =
        getSharedPreferences("wolfman_learning", MODE_PRIVATE)

    private fun loadLearnedSources(): List<Pair<String, String>> {
        val raw = learningPrefs().getString("entries", null) ?: return emptyList()
        val array = runCatching { JSONArray(raw) }.getOrNull() ?: return emptyList()
        return (0 until array.length()).mapNotNull { i ->
            val obj = array.optJSONObject(i) ?: return@mapNotNull null
            val keywords = obj.optString("keywords").ifBlank { null } ?: return@mapNotNull null
            val hint = obj.optString("hint").ifBlank { null } ?: return@mapNotNull null
            keywords to hint
        }
    }

    /**
     * Records a real (question, source-hint) pair to Wolfman's learning store
     * — never the answer itself. `sourceHint` is whatever was actually heard
     * or typed (a domain, a site name, a captured transcription); it is only
     * ever used later as extra search terms, so a live fetch still happens.
     */
    private fun recordLearning(question: String, sourceHint: String) {
        val keywords = question.lowercase().split(Regex("\\W+")).filter { it.length >= 4 }.joinToString(" ")
        val hint = sourceHint.trim().removePrefix("https://").removePrefix("http://").trimEnd('/')
        if (keywords.isBlank() || hint.isBlank()) return
        val existing = loadLearnedSources().toMutableList()
        existing.removeAll { it.first == keywords }
        existing += keywords to hint
        while (existing.size > 50) existing.removeAt(0)
        val array = JSONArray()
        existing.forEach { (kw, h) -> array.put(JSONObject().apply { put("keywords", kw); put("hint", h) }) }
        learningPrefs().edit().putString("entries", array.toString()).apply()
    }

    /** Shares-a-word match against past learned (question, hint) pairs — a routing hint only. */
    private fun findLearnedSource(query: String): String? {
        val queryWords = query.lowercase().split(Regex("\\W+")).filter { it.length >= 4 }.toSet()
        if (queryWords.isEmpty()) return null
        return loadLearnedSources().firstOrNull { (keywords, _) ->
            val overlap = keywords.split(" ").toSet().intersect(queryWords)
            overlap.isNotEmpty()
        }?.second
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
     * by your last question PLUS a request to name its source aloud through
     * the speaker, so its OWN microphone hears it, exactly as if you'd said
     * it. Falls back to ACTION_PROCESS_TEXT (typed handoff) or a plain open
     * when voice-command isn't supported. Wolfman only starts listening again
     * once its OWN voice has gone fully silent (see `onTtsFinished`) — never
     * on a blind timer — so it can't cut off the assistant's own listening
     * session for the question you just asked it.
     */
    private fun handOff(assistant: AssistantCandidate) {
        val question = lastAskedQuestion ?: questionInput.text.toString().trim()
        if (question.isEmpty()) {
            Toast.makeText(this, "Ask Wolfman something first.", Toast.LENGTH_SHORT).show()
            return
        }
        autoListenToggle.isChecked = false
        pendingHandoffQuestion = question

        if (assistant.canVoiceCommand) {
            Log.d(TAG, "handOff: launching ${assistant.packageName} via ACTION_VOICE_COMMAND")
            runCatching { startActivity(Intent(Intent.ACTION_VOICE_COMMAND).setPackage(assistant.packageName)) }
                .onFailure { Log.d(TAG, "handOff: startActivity failed: ${it.message}"); Toast.makeText(this, "Could not launch ${assistant.label}: ${it.message}", Toast.LENGTH_LONG).show(); return }

            val phrase = wakePhrases[assistant.packageName]
            val askForSource = "$question, and please tell me what website or source that came from"
            val utterance = if (phrase != null) "$phrase, $askForSource" else askForSource
            Handler(Looper.getMainLooper()).postDelayed({
                Log.d(TAG, "handOff: speaking utterance=$utterance")
                // Max out media volume first: the assistant only hears this at all if its mic
                // can pick up our own speaker clearly enough to beat the device's echo cancellation.
                val audioManager = getSystemService(AUDIO_SERVICE) as? AudioManager
                audioManager?.setStreamVolume(AudioManager.STREAM_MUSIC, audioManager.getStreamMaxVolume(AudioManager.STREAM_MUSIC), 0)
                tts?.language = Locale.US
                val result = tts?.speak(utterance, TextToSpeech.QUEUE_FLUSH, null, "wolfman-handoff")
                Log.d(TAG, "handOff: tts.speak() returned $result")
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

    /**
     * Wolfman listens with its own microphone (real on-device STT, same as
     * `listenForQuestion`) for the assistant's spoken reply after a handoff,
     * and records whatever it transcribes to Wolfman learning automatically
     * — no typing. Only the transcription is kept as a future search hint,
     * never presented back as an answer itself.
     */
    private fun listenForAssistantReply(question: String) {
        Log.d(TAG, "listenForAssistantReply() called for question=$question")
        pendingHandoffQuestion = null
        if (ContextCompat.checkSelfPermission(this, android.Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            Log.d(TAG, "listenForAssistantReply: RECORD_AUDIO not granted")
            Toast.makeText(this, "Microphone permission is needed to learn from the reply.", Toast.LENGTH_LONG).show()
            return
        }
        val recognizer = speechRecognizer
        if (recognizer == null) {
            Log.d(TAG, "listenForAssistantReply: speechRecognizer is null")
            Toast.makeText(this, "No speech recognizer is available on this device.", Toast.LENGTH_LONG).show()
            return
        }

        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.getDefault())
        }

        Toast.makeText(this, "Wolfman is listening for the reply\u2026", Toast.LENGTH_SHORT).show()
        recognizer.setRecognitionListener(object : RecognitionListener {
            override fun onReadyForSpeech(params: Bundle?) { Log.d(TAG, "listenForAssistantReply: onReadyForSpeech") }
            override fun onResults(results: Bundle?) {
                val text = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()
                Log.d(TAG, "listenForAssistantReply: onResults text=$text")
                Handler(Looper.getMainLooper()).post {
                    if (!text.isNullOrBlank()) {
                        recordLearning(question, text)
                        Toast.makeText(this@MainActivity, "Wolfman learned: \"$text\"", Toast.LENGTH_LONG).show()
                    } else {
                        Toast.makeText(this@MainActivity, "Didn't catch a reply to learn from.", Toast.LENGTH_SHORT).show()
                    }
                }
            }
            override fun onError(error: Int) {
                Log.d(TAG, "listenForAssistantReply: onError code=$error")
                Handler(Looper.getMainLooper()).post {
                    Toast.makeText(this@MainActivity, "Didn't catch a reply to learn from (error $error).", Toast.LENGTH_SHORT).show()
                }
            }
            override fun onBeginningOfSpeech() {}
            override fun onRmsChanged(rmsdB: Float) {}
            override fun onBufferReceived(buffer: ByteArray?) {}
            override fun onEndOfSpeech() {}
            override fun onPartialResults(partialResults: Bundle?) {}
            override fun onEvent(eventType: Int, params: Bundle?) {}
        })

        runCatching { recognizer.startListening(intent) }
            .onFailure { Log.d(TAG, "listenForAssistantReply: startListening threw: ${it.message}") }
    }

    /**
     * Manual "Teach Wolfman" trigger \u2014 always by listening and transcribing,
     * never by typing. Say (or repeat) where the answer came from and Wolfman
     * records that transcript as a future search hint for this question.
     */
    private fun promptTeachWolfman() {
        val question = lastAskedQuestion
        if (question.isNullOrBlank()) {
            Toast.makeText(this, "Ask Wolfman something first.", Toast.LENGTH_SHORT).show()
            return
        }
        listenForAssistantReply(question)
    }
}

