"""Translate the app's semantic emotions into model style instructions."""

from typing import Literal

Emotion = Literal["neutral", "happy", "sad", "surprised", "thoughtful"]

EMOTION_INSTRUCTIONS: dict[Emotion, str] = {
    "neutral": "Speak naturally with a calm, conversational tone and normal pace.",
    "happy": "Speak with a clearly happy, cheerful tone, bright intonation and lively energy.",
    "sad": "Speak with a clearly sad, subdued tone, soft volume and a slightly slower pace.",
    "surprised": "Speak with clear surprise and astonishment, raised pitch and expressive intonation.",
    "thoughtful": "Speak thoughtfully and reflectively, with a measured pace and gentle pauses.",
}


def speech_instruction(emotion: Emotion | None, voice_style: str | None,
                       instruct: str | None) -> str | None:
    parts = [voice_style, EMOTION_INSTRUCTIONS[emotion] if emotion else None, instruct]
    # VoxCPM2 wraps instructions in parentheses; keep its control prompt well formed.
    combined = " ".join(part.strip() for part in parts if part and part.strip())
    return combined.translate(str.maketrans("", "", "()（）")) or None
