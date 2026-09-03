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
    private lateinit var orbView: OrbView
    private lateinit var speakRepliesToggle: CheckBox
    private lateinit var autoListenToggle: CheckBox
    private lateinit var wakeWordToggle: CheckBox
    private lateinit var azureSignInButton: Button
    private lateinit var assistantButtons: LinearLayout
    private lateinit var responseView: TextView
    private var tts: TextToSpeech? = null
    private var speechRecognizer: SpeechRecognizer? = null
    // Bumped by every function that starts a new listen session on the shared recognizer.
    // Each session's callbacks capture the value at the moment they started and check it
    // before acting — a session superseded by a newer one (e.g. Speak tapped while the
    // wake-word loop was still listening) becomes a no-op instead of fighting over the mic.
    private var recognizerGeneration = 0
    private var lastAskedQuestion: String? = null
    private var pendingHandoffQuestion: String? = null
    private var pendingSequentialHandoff: (() -> Unit)? = null
    private var detectedAssistants: List<AssistantCandidate> = emptyList()
    private var resumeWakeWordAfterHandoff = false
    private var resumeAutoListenAfterHandoff = false
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
            setBackgroundColor(android.graphics.Color.parseColor("#0A1628"))
        }

        orbView = OrbView(this)
        val orbSize = (resources.displayMetrics.density * 280).toInt()
        root.addView(orbView, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, orbSize))

        statusView = TextView(this).apply { text = "Detecting on-device AI providers\u2026" }
        questionInput = EditText(this).apply { hint = "Ask Wolfman\u2026" }
        val askButton = Button(this).apply { text = "Ask" }
        val speakButton = Button(this).apply { text = "\uD83C\uDFA4 Speak" }
        speakRepliesToggle = CheckBox(this).apply { text = "Speak replies aloud"; isChecked = true }
        autoListenToggle = CheckBox(this).apply { text = "\uD83D\uDD34 Auto-listen (no tap needed)" }
        wakeWordToggle = CheckBox(this).apply { text = "\uD83D\uDC42 Always listen for \"Hey Wolfman\""; isChecked = true }
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
            if (checked) { wakeWordToggle.isChecked = false; listenForQuestion() }
        }
        wakeWordToggle.setOnCheckedChangeListener { _, checked ->
            Log.d(TAG, "wakeWordToggle checked=$checked")
            if (checked) { autoListenToggle.isChecked = false; startWakeWordListening() }
        }
        // Checkbox defaults to on, but setting isChecked above ran before this listener was
        // attached, so it never fired for that initial value — start the loop explicitly.
        if (wakeWordToggle.isChecked) startWakeWordListening()

        root.addView(statusView)
        root.addView(questionInput)
        root.addView(askButton)
        root.addView(speakButton)
        root.addView(speakRepliesToggle)
        root.addView(autoListenToggle)
        root.addView(wakeWordToggle)
        root.addView(azureSignInButton)
        root.addView(teachButton)
        root.addView(assistantButtons)
        root.addView(responseView)

        setContentView(ScrollView(this).apply { addView(root) })

        detectLocalAsync()
        requestIgnoreBatteryOptimizations()
    }

    /**
     * "Hey Wolfman" needs its foreground service to survive as long as possible in the
     * background — the OS's default battery optimization is the single biggest thing that
     * kills that early. Requesting the exemption needs a real user-facing system dialog
     * (can't be silently granted), so this only fires the request once, and only if not
     * already exempted.
     */
    private fun requestIgnoreBatteryOptimizations() {
        val powerManager = getSystemService(POWER_SERVICE) as? android.os.PowerManager ?: return
        if (powerManager.isIgnoringBatteryOptimizations(packageName)) return
        val intent = Intent(android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, android.net.Uri.parse("package:$packageName"))
        runCatching { startActivity(intent) }
            .onFailure { Log.d(TAG, "requestIgnoreBatteryOptimizations: failed: ${it.message}") }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        val micIndex = permissions.indexOf(android.Manifest.permission.RECORD_AUDIO)
        val micGranted = micIndex != -1 && grantResults.getOrNull(micIndex) == PackageManager.PERMISSION_GRANTED
        // Mic permission is requested asynchronously at launch, so "Hey Wolfman" defaulting to on
        // couldn't actually start listening until the user answers this dialog — kick it off now.
        if (micGranted && wakeWordToggle.isChecked) startWakeWordListening()
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
    /** Strips a leading "Hey Wolfman"/"Wolfman" from recognized text — people naturally say it
     * again as part of the real question even in a separate follow-up listen, not just when
     * said in the same breath as the original wake-up. */
    private fun stripWakeWordPrefix(text: String): String {
        val match = Regex("(?i)^\\s*hey\\s*wolf\\s*man\\s*[,.]?\\s*(.*)").find(text)
            ?: Regex("(?i)^\\s*wolfman\\s*[,.]?\\s*(.*)").find(text)
        val remainder = match?.groupValues?.get(1)?.trim()
        return remainder?.takeIf { it.isNotBlank() } ?: text
    }

    private fun listenForQuestion() {
        Log.d(TAG, "listenForQuestion() called")
        if (ContextCompat.checkSelfPermission(this, android.Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            Log.d(TAG, "listenForQuestion: RECORD_AUDIO not granted")
            ActivityCompat.requestPermissions(this, arrayOf(android.Manifest.permission.RECORD_AUDIO), 1)
            Toast.makeText(this, "Microphone permission is needed to speak to Wolfman.", Toast.LENGTH_LONG).show()
            return
        }
        // Always start from a guaranteed-fresh recognizer instance: calling startListening() on
        // one that's still mid-session from another listen mode (e.g. the wake-word loop) throws
        // ERROR_CLIENT immediately — recreating first avoids that collision instead of just
        // reacting to it after the fact.
        recreateSpeechRecognizer()
        val recognizer = speechRecognizer
        if (recognizer == null) {
            Log.d(TAG, "listenForQuestion: speechRecognizer is null (not available on this device)")
            Toast.makeText(this, "No speech recognizer is available on this device.", Toast.LENGTH_LONG).show()
            return
        }

        val intent = speechRecognizerIntent()
        // The final result frequently comes back empty even though partial results captured the
        // full sentence — a known flakiness in the on-device recognition service. Fall back to
        // the last non-empty partial transcript rather than treating that as "didn't catch it".
        var lastPartialText: String? = null
        val myGen = ++recognizerGeneration

        recognizer.setRecognitionListener(object : RecognitionListener {
            override fun onReadyForSpeech(params: Bundle?) {
                if (myGen != recognizerGeneration) return
                Log.d(TAG, "listenForQuestion: onReadyForSpeech")
                Handler(Looper.getMainLooper()).post { statusView.text = "Listening\u2026"; orbView.setState(OrbState.LISTENING) }
            }
            override fun onResults(results: Bundle?) {
                if (myGen != recognizerGeneration) { Log.d(TAG, "listenForQuestion: onResults ignored, superseded session"); return }
                val text = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull().takeUnless { it.isNullOrBlank() } ?: lastPartialText
                Log.d(TAG, "listenForQuestion: onResults text=$text")
                Handler(Looper.getMainLooper()).post {
                    if (text.isNullOrBlank()) {
                        Toast.makeText(this@MainActivity, "Didn't catch that \u2014 try again.", Toast.LENGTH_SHORT).show()
                        resumeIdleListening()
                    } else {
                        questionInput.setText(stripWakeWordPrefix(text))
                        ask()
                        // If replies are spoken, restart happens after TTS finishes (see onCreate);
                        // otherwise there's no speaker output to avoid overhearing, so restart now.
                        if (!speakRepliesToggle.isChecked) resumeIdleListening()
                    }
                }
            }
            override fun onError(error: Int) {
                if (myGen != recognizerGeneration) { Log.d(TAG, "listenForQuestion: onError ignored, superseded session"); return }
                Log.d(TAG, "listenForQuestion: onError code=$error")
                Handler(Looper.getMainLooper()).post {
                    Toast.makeText(this@MainActivity, "Speech recognition error ($error)", Toast.LENGTH_SHORT).show()
                    resumeIdleListening()
                }
            }
            override fun onBeginningOfSpeech() { Log.d(TAG, "listenForQuestion: onBeginningOfSpeech") }
            private var lastRmsLog = 0L
            override fun onRmsChanged(rmsdB: Float) {
                orbView.pushAudioLevel(rmsdB)
                val now = System.currentTimeMillis()
                if (now - lastRmsLog > 500) { lastRmsLog = now; Log.d(TAG, "listenForQuestion: onRmsChanged rmsdB=$rmsdB") }
            }
            override fun onBufferReceived(buffer: ByteArray?) {}
            override fun onEndOfSpeech() { Log.d(TAG, "listenForQuestion: onEndOfSpeech") }
            override fun onPartialResults(partialResults: Bundle?) {
                if (myGen != recognizerGeneration) return
                val text = partialResults?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()
                if (!text.isNullOrBlank()) { lastPartialText = text; Log.d(TAG, "listenForQuestion: onPartialResults text=$text") }
            }
            override fun onEvent(eventType: Int, params: Bundle?) {}
        })

        recognizer.startListening(intent)
    }

    /** After any question/answer cycle, resumes whichever idle-listening mode is enabled — Auto-listen's full-question loop, or the "Hey Wolfman" wake-word gate — never both at once since they share the one recognizer. */
    private fun resumeIdleListening() {
        when {
            autoListenToggle.isChecked -> restartAutoListenIfEnabled()
            wakeWordToggle.isChecked -> {
                recreateSpeechRecognizer()
                val genAtSchedule = recognizerGeneration
                // Bails if some other listen call raced in during the delay — e.g. the user
                // tapping Speak — instead of blindly restarting and stealing the recognizer back.
                Handler(Looper.getMainLooper()).postDelayed({ if (genAtSchedule == recognizerGeneration) startWakeWordListening() }, 1800)
            }
        }
    }

    /** Restarts listening on its own after a pause long enough for the recognizer to fully reset (avoids ERROR_CLIENT from restarting too fast), only while Auto-listen stays checked. */
    private fun restartAutoListenIfEnabled() {
        Log.d(TAG, "restartAutoListenIfEnabled: autoListenToggle.isChecked=${autoListenToggle.isChecked}")
        if (!autoListenToggle.isChecked) return
        recreateSpeechRecognizer()
        val genAtSchedule = recognizerGeneration
        Handler(Looper.getMainLooper()).postDelayed({ if (genAtSchedule == recognizerGeneration && autoListenToggle.isChecked) listenForQuestion() }, 1800)
    }

    /**
     * Passive "Hey Wolfman" wake-word gate: listens continuously in short cycles doing
     * nothing but watching for the wake phrase (checked against partial results too, since
     * the final result is often empty — see `listenForQuestion`). Hearing it hands off
     * straight into a real question capture via `listenForQuestion()`; otherwise it just
     * quietly restarts itself, as long as the toggle stays checked.
     */
    private fun startWakeWordListening() {
        if (!wakeWordToggle.isChecked) return
        if (tts?.isSpeaking == true) {
            val genAtSchedule = recognizerGeneration
            Handler(Looper.getMainLooper()).postDelayed({ if (genAtSchedule == recognizerGeneration) startWakeWordListening() }, 700)
            return
        }
        if (ContextCompat.checkSelfPermission(this, android.Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) return
        // Always start from a guaranteed-fresh recognizer instance — see listenForQuestion().
        recreateSpeechRecognizer()
        val recognizer = speechRecognizer ?: return
        val myGen = ++recognizerGeneration

        fun wakeWordSaid(text: String?) = text != null && Regex("(?i)hey\\s*wolf\\s*man|\\bwolfman\\b").containsMatchIn(text)
        var handled = false
        fun wake(text: String?) {
            if (handled) return
            handled = true
            Log.d(TAG, "startWakeWordListening: wake word heard, text=$text")
            // Same-breath case ("Hey Wolfman, what's the weather") — strips the wake phrase and
            // asks the remainder directly instead of starting a second listen cycle that would miss it.
            val remainder = text?.let { stripWakeWordPrefix(it) }?.takeIf { it != text }
            Handler(Looper.getMainLooper()).post {
                if (!remainder.isNullOrBlank()) {
                    Log.d(TAG, "startWakeWordListening: question captured in same breath: $remainder")
                    questionInput.setText(remainder)
                    ask()
                } else {
                    statusView.text = "Yes?"
                    recreateSpeechRecognizer()
                    val genAtSchedule = recognizerGeneration
                    // A short but non-zero delay — restarting the recognizer immediately after
                    // recreating it throws ERROR_CLIENT (same fix as Auto-listen's restart).
                    Handler(Looper.getMainLooper()).postDelayed({ if (genAtSchedule == recognizerGeneration) listenForQuestion() }, 800)
                }
            }
        }

        recognizer.setRecognitionListener(object : RecognitionListener {
            override fun onReadyForSpeech(params: Bundle?) {}
            // Deliberately does NOT act on the wake word here: tearing down this live
            // session mid-utterance is exactly what discarded the rest of the sentence
            // when the question was said in the same breath as "Hey Wolfman". Only the
            // final onResults (after the recognizer's own end-of-speech) acts on it.
            override fun onPartialResults(partialResults: Bundle?) {}
            override fun onResults(results: Bundle?) {
                if (myGen != recognizerGeneration) { Log.d(TAG, "startWakeWordListening: onResults ignored, superseded session"); return }
                val text = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()
                Log.d(TAG, "startWakeWordListening: onResults text=$text handled=$handled")
                if (handled) return
                if (wakeWordSaid(text)) { wake(text); return }
                recreateSpeechRecognizer()
                // 1800ms — the same delay Auto-listen needs to avoid ERROR_CLIENT; a shorter
                // gap here (previously 300ms) got the recognizer stuck retrying and immediately
                // failing with ERROR_NO_MATCH in a tight, self-sustaining loop.
                Handler(Looper.getMainLooper()).postDelayed({ if (myGen == recognizerGeneration) startWakeWordListening() }, 1800)
            }
            override fun onError(error: Int) {
                if (myGen != recognizerGeneration) { Log.d(TAG, "startWakeWordListening: onError ignored, superseded session"); return }
                Log.d(TAG, "startWakeWordListening: onError code=$error handled=$handled")
                if (handled) return
                recreateSpeechRecognizer()
                Handler(Looper.getMainLooper()).postDelayed({ if (myGen == recognizerGeneration) startWakeWordListening() }, 1800)
            }
            override fun onBeginningOfSpeech() {}
            override fun onRmsChanged(rmsdB: Float) {}
            override fun onBufferReceived(buffer: ByteArray?) {}
            override fun onEndOfSpeech() {}
            override fun onEvent(eventType: Int, params: Bundle?) {}
        })
        runCatching { recognizer.startListening(speechRecognizerIntent()) }
            .onFailure { Log.d(TAG, "startWakeWordListening: startListening threw: ${it.message}") }
    }

    /** Destroys and recreates the recognizer — reusing one instance across rapid restarts is what causes repeated ERROR_CLIENT (5). */
    private fun recreateSpeechRecognizer() {
        speechRecognizer?.destroy()
        speechRecognizer = if (SpeechRecognizer.isRecognitionAvailable(this)) SpeechRecognizer.createSpeechRecognizer(this) else null
    }

    /** Longer silence timeouts than Android's defaults, so a normal pause mid-question doesn't cut listening off early. */
    private fun speechRecognizerIntent(): Intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
        putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
        putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.getDefault())
        putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
        // Force cloud recognition \u2014 a broken/empty on-device offline model returns onResults
        // with an empty result list instead of an error, which looks identical to "didn't catch that".
        putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, false)
        // EXTRA_SPEECH_INPUT_MINIMUM_LENGTH_MILLIS broke recognition entirely on-device (always
        // timed out with ERROR_NO_MATCH after exactly that long) \u2014 only the silence-length
        // extras actually helped with cutting off too soon.
        putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 2000)
        putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, 2000)
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
        orbView.setState(OrbState.IDLE)
        when (utteranceId) {
            "wolfman-reply" -> resumeIdleListening()
            "wolfman-handoff" -> {
                val question = pendingHandoffQuestion ?: return
                val seqCallback = pendingSequentialHandoff
                pendingSequentialHandoff = null
                if (seqCallback != null) {
                    pendingHandoffQuestion = null
                    // No reply-capture here — give the assistant real time to actually finish
                    // speaking its own answer aloud (8s, then 16s, both still cut Google off
                    // mid-reply in testing) before Wolfman moves on to the next one.
                    Handler(Looper.getMainLooper()).postDelayed(seqCallback, 26000)
                } else {
                    Handler(Looper.getMainLooper()).postDelayed({ listenForAssistantReply(question) }, 3500)
                }
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
            detectedAssistants = assistants

            Handler(Looper.getMainLooper()).post {
                assistantButtons.removeAllViews()
                for (assistant in assistants) {
                    val label = if (assistant.canVoiceCommand) "Ask ${assistant.label} by voice" else "Hand off to ${assistant.label}"
                    assistantButtons.addView(Button(this).apply {
                        text = label
                        setOnClickListener { rememberListeningStateBeforeHandoff(); handOff(assistant) }
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
        orbView.setState(OrbState.THINKING)
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
                if (answer == null) {
                    orbView.setState(OrbState.IDLE)
                    autoHandOffToAssistants(question)
                } else if (speakRepliesToggle.isChecked) {
                    orbView.setState(OrbState.SPEAKING)
                    tts?.language = Locale.US
                    tts?.speak(finalText, TextToSpeech.QUEUE_FLUSH, null, "wolfman-reply")
                    startStopWordListener()
                } else {
                    orbView.setState(OrbState.IDLE)
                }
            }
        }.start()
    }

    /**
     * Listens in parallel with Wolfman's own reply for a spoken "stop" \u2014
     * no button needed. Hearing it cancels the reply immediately and starts
     * listening for your next question right away, instead of waiting for
     * the whole answer to finish. Keeps re-listening for "stop" for as long
     * as Wolfman is actually still speaking.
     */
    private fun startStopWordListener() {
        if (tts?.isSpeaking != true) return
        if (ContextCompat.checkSelfPermission(this, android.Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) return
        // Always start from a guaranteed-fresh recognizer instance — see listenForQuestion().
        recreateSpeechRecognizer()
        val recognizer = speechRecognizer ?: return
        val myGen = ++recognizerGeneration

        fun stopWordSaid(text: String?) = text != null && Regex("\\bstop\\b", RegexOption.IGNORE_CASE).containsMatchIn(text)
        var handled = false

        recognizer.setRecognitionListener(object : RecognitionListener {
            override fun onReadyForSpeech(params: Bundle?) {}
            // Check partials too — the final result frequently comes back empty even after a
            // partial already captured "stop", so waiting for onResults alone can miss it.
            override fun onPartialResults(partialResults: Bundle?) {
                if (myGen != recognizerGeneration) return
                val text = partialResults?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()
                if (!handled && stopWordSaid(text)) {
                    handled = true
                    Log.d(TAG, "startStopWordListener: onPartialResults matched stop, text=$text")
                    Handler(Looper.getMainLooper()).post {
                        tts?.stop()
                        statusView.text = "Stopped \u2014 listening\u2026"
                        recreateSpeechRecognizer()
                        listenForQuestion()
                    }
                }
            }
            override fun onResults(results: Bundle?) {
                if (myGen != recognizerGeneration) return
                val text = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()
                Log.d(TAG, "startStopWordListener: onResults text=$text handled=$handled")
                if (handled) return
                Handler(Looper.getMainLooper()).post {
                    if (stopWordSaid(text)) {
                        tts?.stop()
                        statusView.text = "Stopped \u2014 listening\u2026"
                        recreateSpeechRecognizer()
                        listenForQuestion()
                    } else {
                        recreateSpeechRecognizer()
                        Handler(Looper.getMainLooper()).postDelayed({ if (myGen == recognizerGeneration) startStopWordListener() }, 700)
                    }
                }
            }
            override fun onError(error: Int) {
                if (myGen != recognizerGeneration) return
                Log.d(TAG, "startStopWordListener: onError code=$error handled=$handled")
                if (handled) return
                Handler(Looper.getMainLooper()).post {
                    recreateSpeechRecognizer()
                    Handler(Looper.getMainLooper()).postDelayed({ if (myGen == recognizerGeneration) startStopWordListener() }, 700)
                }
            }
            override fun onBeginningOfSpeech() {}
            override fun onRmsChanged(rmsdB: Float) {}
            override fun onBufferReceived(buffer: ByteArray?) {}
            override fun onEndOfSpeech() {}
            override fun onEvent(eventType: Int, params: Bundle?) {}
        })
        runCatching { recognizer.startListening(speechRecognizerIntent()) }
    }

    /** A conservative, non-exhaustive check — routing signal only, never used to alter the answer text itself. */
    private fun looksLikeRefusal(text: String): Boolean {
        if (text.isBlank()) return true
        val normalized = text.trim().lowercase()
        val patterns = listOf(
            "i cannot help with that", "i can't help with that", "i am not able to", "i'm not able to",
            "i do not understand", "i don't understand", "i cannot answer", "i can't answer",
            "as an ai language model", "i'm unable to", "i am unable to",
            // A provider that "answers" by admitting it couldn't actually fetch live data is a
            // failure too, not a real answer — otherwise it silently dead-ends the whole ask
            // instead of falling through to web search / the Google-Alexa handoff.
            "encountered errors", "encountered an error", "cannot provide you with", "can't provide you with",
            "i couldn't retrieve", "i could not retrieve", "unable to retrieve", "cannot retrieve",
            "couldn't find", "could not find", "cannot find the", "don't have access to", "do not have access to",
            "don't have real-time", "do not have real-time", "as of my last update", "as of my last training",
            "can't browse the internet", "cannot browse the internet", "i'm sorry, but i", "i apologize, but i",
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
     * When no provider could answer, automatically asks every installed assistant in turn
     * (Google first, then Alexa) instead of leaving the user with just a "no live source"
     * message. Each one speaks its own real answer aloud in its own app/voice — Wolfman
     * doesn't try to capture or read it back, it just gives it time to reply before moving
     * on to the next one in the sequence.
     */
    private fun autoHandOffToAssistants(question: String) {
        val order = listOf("com.google.android.googlequicksearchbox", "com.amazon.dee.app")
        val candidates = order.mapNotNull { pkg -> detectedAssistants.firstOrNull { it.packageName == pkg } }
        if (candidates.isEmpty()) return
        Log.d(TAG, "autoHandOffToAssistants: sequence=${candidates.map { it.label }}")
        rememberListeningStateBeforeHandoff()
        autoHandOffStep(question, candidates, 0)
    }

    private fun autoHandOffStep(question: String, candidates: List<AssistantCandidate>, index: Int) {
        if (index >= candidates.size) { restoreListeningAfterHandoff(); return }
        val assistant = candidates[index]
        statusView.text = "Wolfman doesn't know \u2014 asking ${assistant.label}\u2026"
        handOff(assistant, questionOverride = question) { autoHandOffStep(question, candidates, index + 1) }
    }

    /**
     * handOff() force-disables both listening toggles for its duration (so it doesn't fight
     * the assistant for the mic) — these remember what was actually on beforehand so it can
     * resume once the handoff (single or the whole auto-fallback sequence) truly finishes,
     * instead of silently leaving Wolfman deaf to every request after.
     */
    private fun rememberListeningStateBeforeHandoff() {
        resumeWakeWordAfterHandoff = wakeWordToggle.isChecked
        resumeAutoListenAfterHandoff = autoListenToggle.isChecked
    }

    private fun restoreListeningAfterHandoff() {
        val wake = resumeWakeWordAfterHandoff
        val auto = resumeAutoListenAfterHandoff
        resumeWakeWordAfterHandoff = false
        resumeAutoListenAfterHandoff = false
        if (wake) wakeWordToggle.isChecked = true
        else if (auto) autoListenToggle.isChecked = true
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
    private fun handOff(assistant: AssistantCandidate, questionOverride: String? = null, then: (() -> Unit)? = null) {
        val question = questionOverride ?: (lastAskedQuestion ?: questionInput.text.toString().trim())
        if (question.isEmpty()) {
            Toast.makeText(this, "Ask Wolfman something first.", Toast.LENGTH_SHORT).show()
            return
        }
        autoListenToggle.isChecked = false
        wakeWordToggle.isChecked = false
        pendingHandoffQuestion = question
        pendingSequentialHandoff = then

        if (assistant.canVoiceCommand) {
            Log.d(TAG, "handOff: launching ${assistant.packageName} via ACTION_VOICE_COMMAND")
            runCatching { startActivity(Intent(Intent.ACTION_VOICE_COMMAND).setPackage(assistant.packageName)) }
                .onFailure { Log.d(TAG, "handOff: startActivity failed: ${it.message}"); Toast.makeText(this, "Could not launch ${assistant.label}: ${it.message}", Toast.LENGTH_LONG).show(); then?.invoke(); return }

            val phrase = wakePhrases[assistant.packageName]
            val utterance = if (phrase != null) "$phrase, $question" else question
            Handler(Looper.getMainLooper()).postDelayed({
                Log.d(TAG, "handOff: speaking utterance=$utterance")
                // Max out media volume first: the assistant only hears this at all if its mic
                // can pick up our own speaker clearly enough to beat the device's echo cancellation.
                val audioManager = getSystemService(AUDIO_SERVICE) as? AudioManager
                audioManager?.setStreamVolume(AudioManager.STREAM_MUSIC, audioManager.getStreamMaxVolume(AudioManager.STREAM_MUSIC), 0)
                tts?.language = Locale.US
                orbView.setState(OrbState.SPEAKING)
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

        runCatching { startActivity(intent) }
            .onSuccess { then?.let { cb -> Handler(Looper.getMainLooper()).postDelayed(cb, 26000) } }
            .onFailure {
                Toast.makeText(this, "Could not launch ${assistant.label}: ${it.message}", Toast.LENGTH_LONG).show()
                then?.invoke()
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
        // Always start from a guaranteed-fresh recognizer instance — see listenForQuestion().
        recreateSpeechRecognizer()
        val recognizer = speechRecognizer
        if (recognizer == null) {
            Log.d(TAG, "listenForAssistantReply: speechRecognizer is null")
            Toast.makeText(this, "No speech recognizer is available on this device.", Toast.LENGTH_LONG).show()
            return
        }

        val intent = speechRecognizerIntent()
        var lastPartialText: String? = null
        val myGen = ++recognizerGeneration

        Toast.makeText(this, "Wolfman is listening for the reply\u2026", Toast.LENGTH_SHORT).show()
        recognizer.setRecognitionListener(object : RecognitionListener {
            override fun onReadyForSpeech(params: Bundle?) { Log.d(TAG, "listenForAssistantReply: onReadyForSpeech"); orbView.setState(OrbState.LISTENING) }
            override fun onResults(results: Bundle?) {
                if (myGen != recognizerGeneration) return
                val text = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull().takeUnless { it.isNullOrBlank() } ?: lastPartialText
                Log.d(TAG, "listenForAssistantReply: onResults text=$text")
                Handler(Looper.getMainLooper()).post {
                    orbView.setState(OrbState.IDLE)
                    restoreListeningAfterHandoff()
                    if (!text.isNullOrBlank()) {
                        recordLearning(question, text)
                        Toast.makeText(this@MainActivity, "Wolfman learned: \"$text\"", Toast.LENGTH_LONG).show()
                    } else {
                        Toast.makeText(this@MainActivity, "Didn't catch a reply to learn from.", Toast.LENGTH_SHORT).show()
                    }
                }
            }
            override fun onError(error: Int) {
                if (myGen != recognizerGeneration) return
                Log.d(TAG, "listenForAssistantReply: onError code=$error")
                Handler(Looper.getMainLooper()).post {
                    orbView.setState(OrbState.IDLE)
                    restoreListeningAfterHandoff()
                    Toast.makeText(this@MainActivity, "Didn't catch a reply to learn from (error $error).", Toast.LENGTH_SHORT).show()
                }
            }
            override fun onBeginningOfSpeech() {}
            override fun onRmsChanged(rmsdB: Float) { orbView.pushAudioLevel(rmsdB) }
            override fun onBufferReceived(buffer: ByteArray?) {}
            override fun onEndOfSpeech() {}
            override fun onPartialResults(partialResults: Bundle?) {
                val text = partialResults?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()
                if (!text.isNullOrBlank()) lastPartialText = text
            }
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

