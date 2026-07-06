package ai.openclaw.app.chat

import ai.openclaw.app.voice.TalkAudioPlaying
import ai.openclaw.app.voice.TalkSpeakAudio
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

private fun speechClip(bytes: ByteArray = byteArrayOf(1, 2, 3)): TalkSpeakAudio =
  TalkSpeakAudio(
    bytes = bytes,
    provider = "openai",
    outputFormat = "mp3",
    voiceCompatible = null,
    mimeType = "audio/mpeg",
    fileExtension = ".mp3",
  )

private class FakePlayer : TalkAudioPlaying {
  val played = mutableListOf<TalkSpeakAudio>()
  var stopCount = 0
  var gate: CompletableDeferred<Unit>? = null
  var failure: Throwable? = null
  private var activeGate: CompletableDeferred<Unit>? = null

  override suspend fun play(audio: TalkSpeakAudio) {
    played += audio
    failure?.let { throw it }
    val currentGate = gate
    activeGate = currentGate
    currentGate?.await()
  }

  override fun stop() {
    stopCount += 1
    activeGate?.cancel()
    activeGate = null
  }
}

private class FakeLocalSpeech : LocalSpeechSpeaking {
  val spoken = mutableListOf<String>()
  var stopCount = 0

  override suspend fun speak(text: String) {
    spoken += text
  }

  override fun stop() {
    stopCount += 1
  }
}

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
class MessageSpeechControllerTest {
  @Test
  fun playsGatewayClipAndClearsState() =
    runTest {
      val player = FakePlayer().also { it.gate = CompletableDeferred() }
      val local = FakeLocalSpeech()
      val controller =
        MessageSpeechController(
          scope = this,
          synthesizer = { speechClip() },
          player = player,
          localSpeech = local,
        )

      controller.toggle(messageId = "m1", text = "Hello there.")
      assertEquals(MessageSpeechState(messageId = "m1", preparing = true), controller.state.value)

      runCurrent()
      assertEquals(MessageSpeechState(messageId = "m1", preparing = false), controller.state.value)
      assertEquals(1, player.played.size)

      player.gate?.complete(Unit)
      advanceUntilIdle()
      assertNull(controller.state.value)
      assertTrue(local.spoken.isEmpty())
    }

  @Test
  fun fallsBackToLocalSpeechWhenGatewayCannotRender() =
    runTest {
      val player = FakePlayer()
      val local = FakeLocalSpeech()
      val controller =
        MessageSpeechController(
          scope = this,
          synthesizer = { null },
          player = player,
          localSpeech = local,
        )

      controller.toggle(messageId = "m1", text = "Read me aloud")
      advanceUntilIdle()
      assertEquals(listOf("Read me aloud"), local.spoken)
      assertTrue(player.played.isEmpty())
      assertNull(controller.state.value)
    }

  @Test
  fun fallsBackToLocalSpeechWhenClipPlaybackFails() =
    runTest {
      val player = FakePlayer().also { it.failure = IllegalStateException("Unsupported talk audio format") }
      val local = FakeLocalSpeech()
      val controller =
        MessageSpeechController(
          scope = this,
          synthesizer = { speechClip() },
          player = player,
          localSpeech = local,
        )

      controller.toggle(messageId = "m1", text = "Broken clip")
      advanceUntilIdle()
      assertEquals(listOf("Broken clip"), local.spoken)
      assertNull(controller.state.value)
    }

  @Test
  fun toggleWhileActiveStopsWithoutFallback() =
    runTest {
      val player = FakePlayer().also { it.gate = CompletableDeferred() }
      val local = FakeLocalSpeech()
      val controller =
        MessageSpeechController(
          scope = this,
          synthesizer = { speechClip() },
          player = player,
          localSpeech = local,
        )

      controller.toggle(messageId = "m1", text = "Long reply")
      runCurrent()
      assertEquals(MessageSpeechState(messageId = "m1", preparing = false), controller.state.value)

      controller.toggle(messageId = "m1", text = "Long reply")
      assertNull(controller.state.value)
      assertTrue(player.stopCount > 0)
      advanceUntilIdle()
      assertTrue(local.spoken.isEmpty())
      assertNull(controller.state.value)
    }

  @Test
  fun startingAnotherMessageSupersedesTheFirst() =
    runTest {
      val player = FakePlayer().also { it.gate = CompletableDeferred() }
      val local = FakeLocalSpeech()
      val controller =
        MessageSpeechController(
          scope = this,
          synthesizer = { speechClip() },
          player = player,
          localSpeech = local,
        )

      controller.toggle(messageId = "m1", text = "First message")
      runCurrent()
      player.gate = CompletableDeferred()

      controller.toggle(messageId = "m2", text = "Second message")
      runCurrent()
      assertEquals(MessageSpeechState(messageId = "m2", preparing = false), controller.state.value)

      player.gate?.complete(Unit)
      advanceUntilIdle()
      assertNull(controller.state.value)
      assertTrue(local.spoken.isEmpty())
    }

  @Test
  fun blankTextStaysIdle() =
    runTest {
      val player = FakePlayer()
      val local = FakeLocalSpeech()
      val controller =
        MessageSpeechController(
          scope = this,
          synthesizer = { speechClip() },
          player = player,
          localSpeech = local,
        )

      controller.toggle(messageId = "m1", text = "   \n ")
      advanceUntilIdle()
      assertNull(controller.state.value)
      assertTrue(player.played.isEmpty())
      assertTrue(local.spoken.isEmpty())
    }

  @Test
  fun speechTextMirrorsVisibleTextBlocks() {
    val content =
      listOf(
        ChatMessageContent(type = "text", text = "Here is the answer."),
        ChatMessageContent(type = "image", base64 = "aGk="),
        ChatMessageContent(type = "text", text = "   "),
        ChatMessageContent(type = "text", text = "And a follow-up."),
      )

    assertEquals("Here is the answer.\n\nAnd a follow-up.", chatMessageSpeechText(content))
    assertEquals("", chatMessageSpeechText(listOf(ChatMessageContent(type = "toolResult", text = null))))
  }
}
