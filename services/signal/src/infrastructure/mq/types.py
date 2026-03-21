from dataclasses import dataclass
from typing import Literal


@dataclass(frozen=True)
class BindingEvent:
    action:      Literal["bound", "unbound"]
    routing_key: str
    queue:       str
