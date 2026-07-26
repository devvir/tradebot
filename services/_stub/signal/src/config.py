from pydantic_settings import BaseSettings


class Config(BaseSettings):
    ws_url: str
    rest_url: str
    queue_url: str

    model_config = {"env_file": ".env", "extra": "ignore"}


config = Config()
