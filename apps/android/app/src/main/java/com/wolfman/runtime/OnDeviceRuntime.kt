package com.wolfman.runtime

/**
 * WOLFMAN — on-device llama.cpp runtime (Android).
 *
 * The fallback of last resort: runs a bundled GGUF model directly via JNI when
 * no other AI app is installed and no peer device is reachable. Same contract
 * as every desktop provider — probe() performs real inference and never
 * assumes readiness from canRun() alone.
 */

import android.app.ActivityManager
import android.content.Context
import android.os.Build
import android.os.StatFs
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File

data class RuntimeReadiness(
    val canRun: Boolean,
    val reason: String?,
    val freeRamMb: Long,
    val freeStorageMb: Long
)

data class OnDeviceProbeResult(
    val available: Boolean,
    val latencyMs: Long?,
    val failureCode: String?,
    val failureMessage: String?
)

class OnDeviceRuntime(private val ctx: Context) {

    private val modelDir: File
        get() = File(ctx.getExternalFilesDir(null), "models")

    private var loaded = false
    private var nativeHandle: Long = 0L

    init {
        runCatching { System.loadLibrary("wolfman-llama") }
    }

    /** Refusing up front beats an OOM kill mid-answer. */
    fun canRun(): RuntimeReadiness {
        val gguf = modelDir.listFiles { f -> f.extension.equals("gguf", ignoreCase = true) }?.firstOrNull()
        val ram = freeRam()
        val storage = freeStorage()
        if (gguf == null) return RuntimeReadiness(false, "no .gguf model in ${modelDir.path}", ram, storage)

        val requiredMb = (gguf.length() / (1024 * 1024)) + HEADROOM_MB
        if (ram < requiredMb) return RuntimeReadiness(false, "insufficient RAM: need ~${requiredMb}MB, have ${ram}MB", ram, storage)
        if (storage < HEADROOM_MB) return RuntimeReadiness(false, "insufficient storage headroom: have ${storage}MB", ram, storage)
        return RuntimeReadiness(true, null, ram, storage)
    }

    /** Loads the model and confirms it emits a token, returning a MEASURED latency. */
    suspend fun probe(): OnDeviceProbeResult = withContext(Dispatchers.IO) {
        val readiness = canRun()
        if (!readiness.canRun) return@withContext OnDeviceProbeResult(false, null, "NOT_READY", readiness.reason)

        val gguf = modelDir.listFiles { f -> f.extension.equals("gguf", ignoreCase = true) }!!.first()
        val started = System.currentTimeMillis()
        try {
            if (!loaded) {
                nativeHandle = nativeLoadModel(gguf.absolutePath, preferGpuOffload())
                loaded = nativeHandle != 0L
            }
            if (!loaded) return@withContext OnDeviceProbeResult(false, null, "LOAD_FAILED", "native model load returned no handle")

            val token = nativeGenerate(nativeHandle, "Hi", 1)
            if (token.isNullOrEmpty()) OnDeviceProbeResult(false, null, "NO_TOKEN", "model loaded but emitted no token")
            else OnDeviceProbeResult(true, System.currentTimeMillis() - started, null, null)
        } catch (e: Throwable) {
            OnDeviceProbeResult(false, null, "NATIVE_ERROR", e.message ?: e.toString())
        }
    }

    /** Streams tokens from the loaded model. Throws rather than returning a placeholder. */
    fun invoke(prompt: String, maxTokens: Int = 512): Sequence<String> {
        check(loaded) { "probe() must succeed before invoke()" }
        return sequence {
            var remaining = maxTokens
            while (remaining > 0) {
                val token = nativeGenerate(nativeHandle, prompt, 1) ?: break
                yield(token)
                remaining--
            }
        }
    }

    fun dispose() {
        if (loaded) nativeUnload(nativeHandle)
        loaded = false
        nativeHandle = 0L
    }

    // GPU offload via OpenCL/Vulkan on Android 12+; CPU path otherwise.
    private fun preferGpuOffload(): Boolean = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S

    private fun freeRam(): Long {
        val mi = ActivityManager.MemoryInfo()
        (ctx.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager).getMemoryInfo(mi)
        return mi.availMem / (1024 * 1024)
    }

    private fun freeStorage(): Long {
        val dir = modelDir.apply { mkdirs() }
        return StatFs(dir.path).availableBytes / (1024 * 1024)
    }

    private companion object {
        const val HEADROOM_MB = 512L
    }

    // JNI surface backed by the bundled llama.cpp native library (libwolfman-llama.so).
    // Declared here so the Kotlin-side contract is real even before the native lib is linked.
    private external fun nativeLoadModel(path: String, preferGpu: Boolean): Long
    private external fun nativeGenerate(handle: Long, prompt: String, maxTokens: Int): String?
    private external fun nativeUnload(handle: Long)
}
