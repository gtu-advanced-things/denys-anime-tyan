<img src="assets/icon.svg" width="64" height="64" alt="">

# Denys-Anime-Tyan

Created in [T3 Code](https://t3.codes).

## Голосовой агент

Сайт использует существующий вход в Codex через ChatGPT. По умолчанию локальный контейнер `stt` определяет язык каждой реплики из трёх вариантов: русский, английский и грузинский. В настройках можно выбрать язык микрофона вручную. Для грузинского используется отдельная модель Whisper, а голос генерируется eSpeak NG. После паузы запись завершается автоматически. Повторное нажатие на микрофон завершает запись вручную.

Системный промпт GTU хранится в `gtu-prompt.txt`. Агент выбирает листовку из `gtu-posters.json`, а аватар показывает её минимум пять секунд и держит до смены темы или изображения. Листовки можно видеть и при выключенной камере.

```bash
codex login status
docker compose up -d --build
```

Откройте `http://127.0.0.1:22004` в Firefox или Chrome и разрешите доступ к микрофону. Если Codex ещё не авторизован, выполните `codex login` на хосте. Docker использует существующий каталог `CODEX_HOME` (по умолчанию `~/.codex`) для входа и MCP. При UID/GID, отличных от 1000, запустите `APP_UID=$(id -u) APP_GID=$(id -g) docker compose up -d --build`.

## Домен

Docker публикует порт 22004 на всех IPv4-интерфейсах. По умолчанию сайт доступен без пароля. Чтобы ограничить допустимый домен, укажите `PUBLIC_ORIGIN=https://voice.example.com` в `.env` и выполните `docker compose up -d`.

Прокси на другой машине должен направлять запросы на `http://<IP Docker-хоста>:22004`, сохраняя публичный заголовок `Host`. Для доступа к микрофону через домен нужен HTTPS. Отключите буферизацию ответов, чтобы текст и озвучка поступали по мере генерации.

## MCP и системный промпт

Добавьте сервер из терминала хоста. HTTP-сервер должен быть доступен из контейнера.

```bash
codex mcp add my-server --url https://example.com/mcp
docker compose restart voice
```

Для MCP через stdio команда и её файлы должны быть доступны внутри контейнера. Список настроенных серверов и поле системного промпта находятся в настройках сайта.

Сайт не запрашивает подтверждение вызовов. Для доверенного MCP-сервера можно выбрать `default_tools_approval_mode = "writes"` в его секции `[mcp_servers.my-server]` в `config.toml`. Это разрешает вызовы инструментов, которые сервер пометил как доступные только для чтения. Перезапустите контейнер после изменения. [Документация Codex по MCP](https://developers.openai.com/codex/mcp/)

## Аватар, камера и Blender MCP

Разрешите камеру кнопкой под аватаром. MediaPipe определяет положение лица
в кадре и отслеживает кисти на GPU браузера. Кадры остаются в браузере.
Аватар поворачивает голову к лицу и повторяет поднятый большой или средний
палец, раскрытую ладонь, кулак и знак V. Мимика губ следует уровню
воспроизводимого аудио.

При включении камеры аватар поднимается из-за стола. Кнопка **«На весь экран»**
расширяет сцену вместе с чатом. На приветствие аватар машет рукой, на фразы
вроде «не смешно» разводит руками. В 33% запросов он чешет затылок во время
ожидания начала ответа.

Модель, риг, формы мимики и исходная портретная камера экспортированы из
`Office-Studio.blend`. Для повторного экспорта используйте Blender 5.3:

```bash
blender -b Office-Studio.blend --python tools/export-avatar.py -- public/avatar/office-studio.glb
docker compose up -d --build
```

На хосте `sdato@10.203.47.2` дополнение MCP for Blender установлено в
профиль Blender 5.3 и зарегистрировано как `blender` в настройках Codex
пользователя `sdato`. Сцена для работы через MCP открыта из
`~/denys-blender/Office-Studio.blend`. Сокет Blender слушает
`127.0.0.1:9876` на этом хосте. В Blender можно запустить его кнопкой
**Start MCP Server** на боковой панели.

## Голосовые модели OpenAI

Текущий режим использует лимиты Codex по подписке и стандартную скорость. Модель по умолчанию `gpt-6-luna`, переопределение через `CODEX_MODEL` в `.env`. Прямой двусторонний звук через GPT‑Live или Realtime требует ключа API Platform. Если для аккаунта доступны включённые API-кредиты ChatGPT Pro или Business, ими можно покрывать этот режим после активации. [Документация OpenAI об API-кредитах](https://developers.openai.com/api/docs/guides/chatgpt-api-credits)

## Потоковый аниме-голос на GPU

При заданном `TTS_URL` сайт отправляет готовые фразы на GPU по мере
генерации ответа и сразу проигрывает полученные фрагменты PCM. При остановке
сайт отменяет запрос и очищает очередь. При пустом `TTS_URL` используется
встроенная озвучка браузера.

Голос создан один раз в Qwen3-TTS VoiceDesign. Для ответов используется
Qwen3-TTS 0.6B Base через Faster Qwen3-TTS 0.3.0, с прогревом CUDA graphs
и кэшированным референсом. На GPU-хосте нужны совместимые CUDA и PyTorch,
Python 3.12 и следующие пакеты:

```bash
python3 -m venv .voice-venv
. .voice-venv/bin/activate
pip install qwen-tts==0.1.1 faster-qwen3-tts==0.3.0 fastapi uvicorn
python gpu-voice/design.py voice-reference
hf download Qwen/Qwen3-TTS-12Hz-0.6B-Base --local-dir qwen-base

export QWEN_TTS_MODEL="$PWD/qwen-base"
export VOICE_WAV="$PWD/voice-reference/reference.wav"
export VOICE_TRANSCRIPT="$PWD/voice-reference/reference.txt"
uvicorn --app-dir gpu-voice service:app --host 127.0.0.1 --port 22104
```

### Развёртывание на `sl-ai-derg`

На GPU-хосте рабочий каталог находится в `~/workspace/denys-anime-voice`.
На Docker-хосте сервисы пользователя `denys-anime-voice.service` и
`denys-anime-voice-bridge.service` удерживают озвучку и проксируют PCM через
SSH. GPU-сервис принимает HTTP на loopback, а шлюз слушает только интерфейс
сети Docker. Если сеть Docker пересоздана с другим адресом шлюза, обновите
адрес в unit-файле моста и `TTS_URL` в `.env`.

```bash
systemctl --user status denys-anime-voice.service denys-anime-voice-bridge.service
curl -fsS http://127.0.0.1:22004/api/voice
```
