package com.readest.native_tts

import android.content.ContentProviderClient
import android.content.Context
import android.net.Uri
import android.os.Bundle
import android.os.DeadObjectException
import org.json.JSONArray
import java.io.ByteArrayOutputStream
import java.io.DataInputStream
import java.io.EOFException
import java.io.IOException
import java.nio.ByteBuffer
import java.nio.ByteOrder

// Kokoro TTS (io.github.kazeevn.kokorotts) synthesizes through its content
// provider instead of the system TTS API: the system engine queue only starts
// the next utterance once the previous one has nearly finished playing, while
// the provider answers any sentence at once, so readest buffers ahead and plays
// the audio itself. Wire format: see SynthesisProvider in the Kokoro app.
class KokoroClient(private val context: Context) {
    companion object {
        const val AUTHORITY = "io.github.kazeevn.kokorotts.synthesis"
        private val SYNTHESIZE_URI: Uri = Uri.parse("content://$AUTHORITY/synthesize")
    }

    class Voices(val ids: List<String>, val defaultVoice: String, val sampleRate: Int)

    class Speech(val wav: ByteArray, val words: JSONArray)

    class KokoroException(message: String) : IOException(message)

    // Unstable on purpose: a stable reference would take readest down with the
    // Kokoro process if the latter died (it is large and the first one the
    // low-memory killer picks). Held between requests so the engine process
    // shares readest's priority instead of being cached and killed.
    private var client: ContentProviderClient? = null

    @Synchronized
    private fun client(): ContentProviderClient =
        client
            ?: context.contentResolver.acquireUnstableContentProviderClient(AUTHORITY)?.also { client = it }
            ?: throw KokoroException("Kokoro TTS is not installed")

    @Synchronized
    fun release() {
        client?.close()
        client = null
    }

    private fun <T> withClient(block: (ContentProviderClient) -> T): T =
        try {
            block(client())
        } catch (e: DeadObjectException) {
            // The Kokoro process died: reconnect once, which restarts it.
            release()
            block(client())
        }

    fun voices(): Voices? {
        val result = try {
            withClient { it.call("voices", null, null) }
        } catch (e: KokoroException) {
            return null
        } ?: return null
        val ids = result.getStringArray("voices")?.toList() ?: return null
        return Voices(ids, result.getString("default") ?: "", result.getInt("sampleRate", 24000))
    }

    fun cancel(id: String) {
        try {
            withClient { it.call("cancel", id, null) }
        } catch (_: Exception) {
        }
    }

    // Blocking: returns once the whole sentence is synthesized.
    fun synthesize(id: String, text: String, voice: String, sampleRate: Int): Speech {
        val opts = Bundle().apply {
            putString("id", id)
            putString("text", text)
            putString("voice", voice)
        }
        val afd = withClient { it.openTypedAssetFileDescriptor(SYNTHESIZE_URI, "*/*", opts) }
            ?: throw KokoroException("Kokoro TTS returned no stream")
        val pcm = ByteArrayOutputStream()
        val words = JSONArray()
        DataInputStream(afd.createInputStream().buffered()).use { input ->
            try {
                loop@ while (true) {
                    when (val tag = input.readByte().toInt().toChar()) {
                        'W' -> repeat(input.readInt()) {
                            words.put(JSONArray().put(input.readInt()).put(input.readInt()).put(input.readInt()))
                        }
                        'A' -> {
                            val bytes = ByteArray(input.readInt())
                            input.readFully(bytes)
                            pcm.write(bytes)
                        }
                        'E' -> break@loop
                        'X' -> throw KokoroException(input.readUTF())
                        else -> throw KokoroException("Unexpected record '$tag'")
                    }
                }
            } catch (e: EOFException) {
                throw KokoroException("Kokoro TTS stream ended early")
            }
        }
        return Speech(wav(pcm.toByteArray(), sampleRate), words)
    }

    // 16-bit mono PCM in a WAV container, for decodeAudioData.
    private fun wav(pcm: ByteArray, sampleRate: Int): ByteArray {
        val header = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN).apply {
            put("RIFF".toByteArray()); putInt(36 + pcm.size); put("WAVE".toByteArray())
            put("fmt ".toByteArray()); putInt(16); putShort(1); putShort(1)
            putInt(sampleRate); putInt(sampleRate * 2); putShort(2); putShort(16)
            put("data".toByteArray()); putInt(pcm.size)
        }
        return header.array() + pcm
    }
}
