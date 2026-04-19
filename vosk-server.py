#!/usr/bin/env python3
"""Local Vosk speech-to-text WebSocket server.

Runs on localhost:2700. Accepts PCM int16 audio at 16kHz mono via WebSocket,
returns JSON transcript messages compatible with the voice-trigger.js client:
  {"type": "TranscriptInterim", "data": "partial text..."}
  {"type": "TranscriptText", "data": "final text."}
  {"type": "TranscriptEndpoint"}
"""

import asyncio
import json
import os
import signal
import sys

import websockets
from vosk import Model, KaldiRecognizer

MODEL_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                          "vosk-model", "vosk-model-en-us-0.22")
HOST = "127.0.0.1"
PORT = 2700
SAMPLE_RATE = 16000


def load_model():
    if not os.path.isdir(MODEL_PATH):
        print(f"[Vosk] Model not found at {MODEL_PATH}", file=sys.stderr)
        sys.exit(1)
    print(f"[Vosk] Loading model from {MODEL_PATH}...")
    model = Model(MODEL_PATH)
    print("[Vosk] Model loaded")
    return model


async def handle_client(websocket, model):
    print(f"[Vosk] Client connected: {websocket.remote_address}")
    rec = KaldiRecognizer(model, SAMPLE_RATE)
    rec.SetWords(False)

    try:
        async for message in websocket:
            # Text messages are control commands (KeepAlive, CloseStream)
            if isinstance(message, str):
                try:
                    msg = json.loads(message)
                    if msg.get("type") == "CloseStream":
                        # Process any remaining audio
                        rec.FinalResult()
                        break
                except json.JSONDecodeError:
                    pass
                continue

            # Binary message = PCM int16 audio data
            if rec.AcceptWaveform(message):
                result = json.loads(rec.Result())
                text = result.get("text", "").strip()
                if text:
                    await websocket.send(json.dumps({
                        "type": "TranscriptText",
                        "data": text
                    }))
                    await websocket.send(json.dumps({
                        "type": "TranscriptEndpoint"
                    }))
            else:
                partial = json.loads(rec.PartialResult())
                text = partial.get("partial", "").strip()
                if text:
                    await websocket.send(json.dumps({
                        "type": "TranscriptInterim",
                        "data": text
                    }))
    except websockets.exceptions.ConnectionClosed:
        pass
    finally:
        # Discard any buffered audio — don't send stale results
        try:
            rec.FinalResult()  # flush internal buffers
        except Exception:
            pass
        # Delete the recognizer to free all Kaldi memory/CPU resources
        del rec
        print(f"[Vosk] Client disconnected, recognizer released: {websocket.remote_address}")


async def main():
    model = load_model()

    async def handler(websocket):
        await handle_client(websocket, model)

    stop = asyncio.get_event_loop().create_future()

    def shutdown():
        if not stop.done():
            stop.set_result(None)

    for sig in (signal.SIGINT, signal.SIGTERM):
        asyncio.get_event_loop().add_signal_handler(sig, shutdown)

    async with websockets.serve(handler, HOST, PORT):
        print(f"[Vosk] Server listening on ws://{HOST}:{PORT}")
        await stop

    print("[Vosk] Server stopped")


if __name__ == "__main__":
    asyncio.run(main())
