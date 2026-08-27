from __future__ import annotations

from dataclasses import dataclass
import json


@dataclass(frozen=True)
class TrainingDispatch:
    workspace_id: str
    radar_id: str
    definition_version: int
    training_request_id: str
    correlation_id: str

    @classmethod
    def parse(cls, raw: bytes | str | dict[str, object]) -> "TrainingDispatch":
        value = json.loads(raw) if isinstance(raw, (bytes, str)) else raw
        allowed = {"workspaceId", "radarId", "definitionVersion", "trainingRequestId", "correlationId"}
        if not isinstance(value, dict) or set(value) != allowed:
            raise ValueError("invalid propensity dispatch shape")
        strings = [value["workspaceId"], value["radarId"], value["trainingRequestId"], value["correlationId"]]
        if any(not isinstance(item, str) or not item.strip() for item in strings):
            raise ValueError("invalid propensity dispatch identity")
        version = value["definitionVersion"]
        if not isinstance(version, int) or version < 1:
            raise ValueError("invalid propensity definition version")
        return cls(str(value["workspaceId"]), str(value["radarId"]), version, str(value["trainingRequestId"]), str(value["correlationId"]))

    def as_dict(self) -> dict[str, object]:
        return {"workspaceId": self.workspace_id, "radarId": self.radar_id, "definitionVersion": self.definition_version, "trainingRequestId": self.training_request_id, "correlationId": self.correlation_id}
