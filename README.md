# Dota API

Локальный проект персональной аналитики Dota 2. После E00-T04 доступны собираемый Next.js web, запускаемый Node.js worker, Kotlin/JVM CLI, общие схемы данных и проверяемый NDJSON-протокол; настроены локальный Git и публичный GitHub-репозиторий. Карта, таймлайн и состояния героев входят в будущий MVP; видео отложено.

История матчей, скачивание, очередь, база данных и LLM пока не подключены. Разбор локального `.dem` доступен через Kotlin CLI; web и worker ещё не используют его. Стартовая страница показывает состояние разработки. `/api/health` проверяет только работу web-процесса.

В E01-T01 отдельно проверены реальные запросы профиля и истории OpenDota без ключей: получены 20 последних матчей и подтверждён участник в пяти сводках. [Результаты и ограничения](docs/data-source-validation.md) включают параметры запросов и локальные артефакты.

В E01-T02 [получены пять контрольных реплеев](docs/replay-download-validation.md), проверены хеши и внутренние ID. Все пять ссылок имеют суффикс `.bz2`, но фактическое сжатие — Zstandard. Архивы и распакованные `.dem` хранятся только локально в `data/replay-validation/2026-10-12-e01-t02/`, суммарно около 623 MB. Отчёты в Git обезличены. В E01-T03 [проверен Kotlin/Clarity-парсер](docs/replay-parser-validation.md): пять реплеев, 450 совпавших итоговых показателей, события смертей, игровые часы и паузы. Следующая задача — E01-T04: обзор и контекст решений.

## Требования и фиксированные версии

Инструкции ниже предназначены для macOS/Linux. Для запуска Kotlin-процесса нужен JDK 21, для web/worker — Node.js и npm из таблицы. Docker на этом этапе не требуется; общий запуск через Docker Compose относится к E10-T01.

| Инструмент | Версия | Где зафиксирована |
| --- | --- | --- |
| Node.js | 26.3.0 | `.nvmrc`, `.node-version`, `package.json` |
| npm | 11.16.0 | `package.json`, корневой `package-lock.json` |
| Next.js | 16.4.0 | `apps/web/package.json` |
| React / React DOM | 19.3.0 | `apps/web/package.json` |
| TypeScript | 5.9.3 | `package.json` |
| JDK | 21; локальная проверка на OpenJDK 21.0.11 | JVM toolchain в `build.gradle.kts`; JDK устанавливается отдельно |
| Kotlin JVM plugin | 2.4.20 | `services/replay-parser/build.gradle.kts` |
| Gradle | 9.5.1 | Wrapper и SHA-256 дистрибутива в `gradle-wrapper.properties` |

Прямые npm-зависимости имеют точные версии, транзитивные закрепляет lockfile. Зависимости Kotlin закреплены в `gradle.lockfile`. В сборке используется Wrapper; глобальный Gradle не нужен. При первом запуске npm и Gradle потребуется доступ к реестрам и серверу дистрибутива Gradle.

Выбор сборки основан на [документации Next.js](https://nextjs.org/docs/app/getting-started/installation), [совместимости Kotlin/Gradle](https://kotlinlang.org/docs/gradle-configure-project.html) и [проверке дистрибутива Wrapper](https://docs.gradle.org/current/userguide/gradle_wrapper.html#sec:verification). Совместимость Clarity 5.0.1 / protobuf 7.1 с Kotlin и пятью контрольными реплеями подтверждена в E01-T03; версии закреплены в Gradle lockfile.

## Установка и сборка

Из корня проекта:

```sh
node --version
npm --version
java -version
npm ci
npm run typecheck
npm run build
npm run test:contracts
npm run smoke
```

Если используете nvm, `nvm install` и `nvm use` в корне выберут версию из `.nvmrc`. При нескольких JDK укажите `JAVA_HOME` на установленный JDK 21. Проверка `engines` включена: несовпадающие версии Node.js/npm нужно исправить до установки зависимостей.

`build` последовательно собирает общие пакеты, worker, web и Kotlin CLI. Gradle создаёт запускаемый дистрибутив в `services/replay-parser/build/install/replay-parser`. Typecheck можно запускать до сборки: команда web сама генерирует типы маршрутов.

`smoke` требует уже собранные компоненты и проверяет импорт общих пакетов, запуск и остановку worker, Kotlin CLI и HTTP-ответы production web. Для web временно выбирается свободный порт на `127.0.0.1`; процессы завершаются после проверки. Реальные API, база и ключи не нужны.

`test:contracts` также требует сборку. Общие синтетические примеры проходят через TypeScript и Kotlin; проверяются восемь видов записей, точность строковых ID, неизвестные значения, временная ось и отклонение некорректного NDJSON. Схема встроена в дистрибутив CLI. Формат данных `0.1.0`, транспорт `1.0.0`, ограничения и правила миграции описаны в [docs/contracts.md](docs/contracts.md).

При изменении зависимостей обновляйте версии и lockfiles явно. Для npm используется `npm install`; для зависимостей Kotlin:

```sh
./services/replay-parser/gradlew --project-dir services/replay-parser --no-daemon build installDist --write-locks
```

## Запуск компонентов

После сборки, в отдельных терминалах:

```sh
# Web: http://127.0.0.1:3000
npm run start:web

# Worker: PostgreSQL и pg-boss; задайте DATABASE_URL в .env
npm run start:worker

# Однократная проверка Kotlin CLI
npm run start:parser -- --check
```

Дополнительные проверки:

```sh
curl --fail http://127.0.0.1:3000/api/health
npm run start:worker -- --check
npm run start:parser -- --version
```

Worker требует `DATABASE_URL`, подключается к pg-boss и сообщает `mode: infrastructure`, `queueConnected: true`; `--check` проверяет конфигурацию без подключения. Проверка Kotlin CLI сообщает `mode: basic`, `replayParsing: true`; неизвестные аргументы, включая позиционный путь к реплею, завершаются с кодом 2 и диагностикой в stderr. `--protocol` выдаёт записи и `complete` (код 0), при ошибке реплея — `error` (код 3). `--validate-ndjson` проверяет и возвращает поток записей. Для чистого stdout вызывайте CLI напрямую, без вывода npm.

Пример ниже использует синтетический путь из fixture и ожидаемо возвращает `invalid_replay`, код 3. Для реального запуска передайте запрос с локальным `replayPath` и ожидаемым ID матча; результаты сохраняйте под `data/`. Формат описан в [контрактах](docs/contracts.md), воспроизводимый прогон — в [отчёте E01-T03](docs/replay-parser-validation.md).

```sh
./services/replay-parser/build/install/replay-parser/bin/replay-parser --protocol \
  < packages/contracts/fixtures/request.ndjson
```

При занятом порте web можно запустить командой `npm run start:web -- --port 3001`. Все команды web привязывают сервер к `127.0.0.1`.

Для разработки с обновлением при изменениях:

```sh
npm run dev:web
npm run dev:worker
```

Пакет `contracts` содержит JSON Schema, генерируемые TypeScript-типы, runtime-валидаторы и NDJSON-кодек. Общий JSON — источник истины; `src/generated` создаётся автоматически при сборке/проверке типов и не сохраняется в Git. Пакет `analysis` пока содержит только точку входа; правила появятся в E06. Worker подключён к PostgreSQL/pg-boss; схема, Storage и инфраструктура выполнения описаны в [docs/persistence.md](docs/persistence.md). Интеграция загрузки и парсера относится к E04.

## Конфигурация и локальные данные

`.env.example` содержит безопасные примеры будущих серверных настроек. `db:migrate`, `start:web` и `start:worker` читают DATABASE_URL из локального `.env`; worker также читает STORAGE_ROOT. Ключи источников и LLM пока не нужны. Механизм загрузки настроек будет подключаться вместе с соответствующими адаптерами. Секретные параметры нельзя переносить в `NEXT_PUBLIC_*`.

`.gitignore` исключает `.env`/`.env.*` (кроме `.env.example`), реплеи `.dem`/`.dem.bz2`/`.dem.zst`, локальное хранилище `data/`, временные артефакты, зависимости, кэши и результаты сборки. Исходный код, lockfiles и файлы Gradle Wrapper, включая JAR, сохраняются в системе контроля версий.

## Git и GitHub

Публичный репозиторий: [slavenski01/dota-api](https://github.com/slavenski01/dota-api). Основная ветка — `main`; в текущей локальной копии настроены `origin` → `https://github.com/slavenski01/dota-api.git` и upstream `origin/main`. Первый push выполнен. Для коммитов этой копии локально задан GitHub noreply-адрес владельца аккаунта; в новом клоне имя и email автора настраиваются отдельно.

Перед работой, из корня проекта с чистым рабочим деревом:

```sh
git status
git pull --ff-only
```

После правок проверьте изменения, укажите конкретные файлы для коммита и отправьте их. Ниже пример для README; замените путь и сообщение своими:

```sh
git diff
git add -- README.md
git diff --cached
git commit -m "docs: update project notes"
git push
git status
```

Новые файлы видны в `git status`; они попадут в историю после явного `git add`. Перед push проверяйте содержимое коммита. Для следующих задач можно создавать ветки `codex/<имя-задачи>`; первый push новой ветки выполняется командой `git push -u origin HEAD`. Для записи в GitHub нужна авторизация владельца или участника с правом push.

Клонирование на другую машину:

```sh
git clone https://github.com/slavenski01/dota-api.git
cd dota-api
```

После клонирования следуйте разделу установки и сборки. Публичный доступ относится к исходникам; приложение по-прежнему запускается локально.

## Структура

```text
apps/web/               Next.js App Router, стартовая страница, /api/health
apps/worker/            Node.js + TypeScript, жизненный цикл процесса
services/replay-parser/ Kotlin/JVM CLI, Gradle Kotlin DSL и Wrapper
packages/contracts/    общие схемы, типы, валидаторы, NDJSON и примеры
packages/analysis/     место для детерминированных правил E06
scripts/               проверки контрактов между языками и запуска компонентов
docs/                  архитектура, контракты и исследовательские заметки
```

Подробнее: [архитектура](docs/architecture.md), [контракты](docs/contracts.md), [план и журнал сессий](tasks-plan.md), [аналитическая методика](.agents/skills/dota-match-analysis/SKILL.md).


## E02: база, хранилище и задания

Эпик E02 реализован: PostgreSQL, миграции, неизменяемые версии, Storage, pg-boss, отмена/восстановление и API состояния. Подробности, пределы ресурсов и backup/restore — в [docs/persistence.md](docs/persistence.md).

Для запуска нужен доступный сервер PostgreSQL 18 и локальный `.env` с `DATABASE_URL` и `STORAGE_ROOT` (без `NEXT_PUBLIC_`). Тесты используют отдельный временный PostgreSQL, не требуют Docker и не создают постоянную базу приложения. Общий Docker Compose остаётся в E10.

```sh
npm run build:ts
npm run db:migrate
# В отдельных терминалах:
npm run start:web
npm run start:worker
```

Откройте `http://127.0.0.1:3000/jobs`: запуск возвращает ID, URL сохраняет его для повторного открытия, polling показывает состояние и позволяет отменить задачу. Получение реплеев и запуск парсера из приложения подключаются в E04: пока штатная обработка явно сообщает о недоступном адаптере. Проверка полного цикла в E02 использует синтетические обработчики.

```sh
npm run test:postgres-harness
npm run test:persistence
npm run test:storage
npm run test:jobs
npm run test:workflow
npm run test:contracts
npm run smoke
```

В macOS/Linux тесты запускаются от обычного пользователя; `embedded-postgres` должен выполнить свой postinstall при `npm ci`. PostgreSQL слушает только loopback, временные пароли не выводятся. Команды `start:web`, `dev:web`, `start:worker`, `dev:worker`, `db:migrate` читают `.env` корня.
