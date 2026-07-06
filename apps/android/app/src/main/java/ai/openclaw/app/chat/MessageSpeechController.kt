package ai.openclaw.app.chat

import ai.openclaw.app.gateway.GatewaySession
import ai.openclaw.app.voice.TalkAudioPlaying
import ai.openclaw.app.voice.TalkSpeakAudio
import android.content.Context
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.util.Log
import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

private const val TAG = "MessageSpeech"

/** Chat message text sent to TTS mirrors the bubble's visible text blocks. */
internal fun chatMessageSpeechText(content: List<ChatMessageContent>): String =
  content
    .filter { it.type == "text" }
    .mapNotNull { part -> part.text?.trim()?.takeIf(String::isNotEmpty) }
    .joinToString("\n\n")

/** Playback state for the chat "Listen" action; null when idle. */
data class MessageSpeechState(
  val messageId: String,
  val preparing: Boolean,
)

/** Renders message text to an audio clip; null means fall back to local TTS. */
internal fun interface MessageSpeechSynthesizing {
  suspend fun synthesize(text: String): TalkSpeakAudio?
}

/** Speaks text with the on-device engine when the gateway cannot render audio. */
internal interface LocalSpeechSpeaking {
  suspend fun speak(text: String)

  fun stop()
}

/** Gateway tts.speak client: renders text with the configured TTS provider chain. */
internal class MessageSpeechClient(
  private val session: GatewaySession,
  private val json: Json = Json { ignoreUnknownKeys = true },
) : MessageSpeechSynthesizing {
  override suspend fun synthesize(text: String): TalkSpeakAudio? {
    val response =
      try {
        session.requestDetailed(
          method = "tts.speak",
          paramsJson = json.encodeToString(TtsSpeakRequest(text = text)),
          timeoutMs = 60_000,
        )
      } catch (err: CancellationException) {
        throw err
      } catch (err: Throwable) {
        Log.d(TAG, "tts.speak request failed: ${err.message ?: err::class.simpleName}")
        return null
      }
    if (!response.ok) {
      // Any gateway-side failure (no provider configured, synthesis error, or an
      // older gateway without tts.speak) degrades to the on-device voice.
      Log.d(TAG, "tts.speak unavailable: ${response.error?.message ?: "unknown error"}")
      return null
    }
    val payload =
      try {
        json.decodeFromString<TtsSpeakResponse>(response.payloadJson ?: "")
      } catch (err: Throwable) {
        Log.d(TAG, "tts.speak payload invalid: ${err.message ?: err::class.simpleName}")
        return null
      }
    val bytes =
      try {
        android.util.Base64.decode(payload.audioBase64, android.util.Base64.DEFAULT)
      } catch (err: Throwable) {
        Log.d(TAG, "tts.speak audio decode failed: ${err.message ?: err::class.simpleName}")
        return null
      }
    if (bytes.isEmpty()) return null
    return TalkSpeakAudio(
      bytes = bytes,
      provider = payload.provider,
      outputFormat = payload.outputFormat,
      voiceCompatible = null,
      mimeType = payload.mimeType,
      fileExtension = payload.fileExtension,
    )
  }
}

@Serializable
internal data class TtsSpeakRequest(
  val text: String,
)

@Serializable
private data class TtsSpeakResponse(
  val audioBase64: String,
  val provider: String,
  val outputFormat: String? = null,
  val mimeType: String? = null,
  val fileExtension: String? = null,
)

/** Drives the chat "Listen" action: one message speaks at a time, gateway audio first. */
internal class MessageSpeechController(
  private val scope: CoroutineScope,
  private val synthesizer: MessageSpeechSynthesizing,
  private val player: TalkAudioPlaying,
  private val localSpeech: LocalSpeechSpeaking,
) {
  private val _state = MutableStateFlow<MessageSpeechState?>(null)
  val state: StateFlow<MessageSpeechState?> = _state.asStateFlow()

  // Monotonic token: a superseded playback's completion must not clear the
  // state owned by a newer one.
  private val generation = AtomicLong(0)
  private var job: Job? = null

  fun toggle(
    messageId: String,
    text: String,
  ) {
    if (_state.value?.messageId == messageId) {
      stop()
      return
    }
    start(messageId = messageId, text = text)
  }

  fun stop() {
    generation.incrementAndGet()
    job?.cancel()
    job = null
    player.stop()
    localSpeech.stop()
    _state.value = null
  }

  private fun start(
    messageId: String,
    text: String,
  ) {
    stop()
    val spoken = text.trim()
    if (spoken.isEmpty()) return
    val token = generation.incrementAndGet()
    _state.value = MessageSpeechState(messageId = messageId, preparing = true)
    job =
      scope.launch {
        try {
          val clip = synthesizer.synthesize(spoken)
          if (generation.get() != token) return@launch
          _state.value = MessageSpeechState(messageId = messageId, preparing = false)
          if (!playClip(clip) && generation.get() == token) {
            // Gateway clip unavailable or unplayable: on-device synthesis keeps
            // Listen working when no TTS provider is configured.
            localSpeech.speak(spoken)
          }
        } finally {
          if (generation.get() == token) {
            _state.value = null
          }
        }
      }
  }

  /** True when a gateway clip played; cancellation propagates to the caller. */
  private suspend fun playClip(clip: TalkSpeakAudio?): Boolean {
    if (clip == null) return false
    return try {
      player.play(clip)
      true
    } catch (err: CancellationException) {
      throw err
    } catch (err: Throwable) {
      Log.w(TAG, "clip playback failed: ${err.message ?: err::class.simpleName}")
      false
    }
  }
}

/** Minimal on-device TTS wrapper for the chat Listen fallback voice. */
internal class SystemSpeechSpeaker(
  private val context: Context,
) : LocalSpeechSpeaking {
  private val lock = Any()
  private var engine: TextToSpeech? = null
  private var ready: CompletableDeferred<Boolean>? = null
  private var active: CompletableDeferred<Unit>? = null

  override suspend fun speak(text: String) {
    val engine = ensureEngine() ?: return
    val utteranceId = "chat-listen-${System.nanoTime()}"
    val done = CompletableDeferred<Unit>()
    synchronized(lock) {
      active?.cancel()
      active = done
    }
    engine.setOnUtteranceProgressListener(
      object : UtteranceProgressListener() {
        override fun onStart(id: String?) {}

        override fun onDone(id: String?) {
          if (id == utteranceId) done.complete(Unit)
        }

        @Deprecated("Deprecated in Java")
        override fun onError(id: String?) {
          if (id == utteranceId) done.complete(Unit)
        }

        override fun onError(
          id: String?,
          errorCode: Int,
        ) {
          if (id == utteranceId) done.complete(Unit)
        }
      },
    )
    if (engine.speak(text, TextToSpeech.QUEUE_FLUSH, null, utteranceId) != TextToSpeech.SUCCESS) {
      done.complete(Unit)
      return
    }
    try {
      done.await()
    } finally {
      synchronized(lock) {
        if (active === done) active = null
      }
    }
  }

  override fun stop() {
    synchronized(lock) {
      active?.cancel()
      active = null
    }
    engine?.stop()
  }

  private suspend fun ensureEngine(): TextToSpeech? {
    val pending =
      synchronized(lock) {
        ready ?: CompletableDeferred<Boolean>().also { deferred ->
          ready = deferred
          engine = TextToSpeech(context) { initStatus -> deferred.complete(initStatus == TextToSpeech.SUCCESS) }
        }
      }
    return if (pending.await()) engine else null
  }
}
