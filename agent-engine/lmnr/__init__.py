from collections.abc import Callable
from functools import wraps
from typing import Any, TypeVar, cast

F = TypeVar('F', bound=Callable[..., Any])


def observe(*args: Any, **kwargs: Any) -> Callable[[F], F]:
	"""Local shim for lmnr.observe to avoid incompatibilities.

	Accepts any parameters (including metadata) and returns a pass-through decorator.
	"""

	def decorator(func: F) -> F:
		@wraps(func)
		def wrapper(*f_args: Any, **f_kwargs: Any):
			return func(*f_args, **f_kwargs)

		return cast(F, wrapper)

	return decorator


