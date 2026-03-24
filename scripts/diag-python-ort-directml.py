from __future__ import annotations

import json
import os
import sys
from pathlib import Path


def main() -> int:
    import onnxruntime as ort

    model_path = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("models") / "silero_vad.onnx"
    model_path = model_path.resolve()
    if not model_path.exists():
        raise FileNotFoundError(f"Model not found: {model_path}")

    preferred = ["DmlExecutionProvider", "CPUExecutionProvider"]
    available = ort.get_available_providers()
    result: dict[str, object] = {
        "model": str(model_path),
        "availableProviders": available,
        "preferredProviders": preferred,
        "sessionCreated": False,
        "sessionProviders": [],
        "error": "",
        "pid": os.getpid(),
    }

    try:
        session = ort.InferenceSession(str(model_path), providers=preferred)
        result["sessionCreated"] = True
        result["sessionProviders"] = session.get_providers()
    except Exception as exc:  # noqa: BLE001
        result["error"] = str(exc)

    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
