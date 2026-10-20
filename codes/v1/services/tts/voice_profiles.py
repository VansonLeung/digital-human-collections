"""Server-configured reference voices shared by one loaded TTS model."""

from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class VoiceProfile:
    ref_audio: str | None
    ref_text: str | None
    style: str = ""

    @property
    def audio_path(self):
        if not self.ref_audio:
            return None
        path = Path(self.ref_audio).expanduser()
        if not path.is_absolute():
            path = Path(__file__).parent / path
        return str(path)

    @property
    def configured(self):
        return bool(self.audio_path and Path(self.audio_path).is_file()
                    and self.ref_text and self.ref_text.strip())
