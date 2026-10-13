const messages: Record<string,string> = {
  invalid_review: "Проверьте поля оценки: нужны статус, пояснение, автор, источник и перспектива. Пояснение и альтернатива — до 2000 символов.",
  review_requires_alternative: "Для подтверждённой ошибки нужна выполнимая альтернатива.",
  review_conflict: "Оценка уже изменена в другой вкладке. Загрузите актуальную оценку и пересмотрите изменения.",
  review_map_unavailable: "Карта ещё не откалибрована. Укажите фактический источник проверки: таймлайн или клиент Dota 2.",
  episode_not_found: "Эпизод не найден для этого игрока и набора. Откройте его из карточки матча.",
  analysis_not_found: "Данные не найдены для выбранного игрока и набора.",
  invalid_context_request: "Время, перспектива или ссылка на эпизод некорректны.",
  dataset_not_validated: "Проверенный набор данных пока недоступен.",
  invalid_analysis_options: "Выберите ключевой предмет и опишите план игры (до 2000 символов), либо оставьте оба поля пустыми.",
  analysis_options_conflict: "Для этого матча уже выполняется задание с другим игроком или планом. Дождитесь завершения или отмените его.",
  origin_not_allowed: "Адрес страницы не совпадает с адресом локального сервиса. Откройте приложение через localhost или 127.0.0.1.",
  invalid_player_id: "Введите корректный ID игрока. Нулевой и анонимный ID выбрать нельзя.",
  invalid_steam_type: "Это не SteamID64 личного аккаунта. Проверьте число и выбранный тип ID.",
  invalid_id_kind: "Выберите тип ID.",
  profile_identity_mismatch: "ID в ответе источника не совпал с запросом. Предыдущий выбор сохранён.",
  provider_unavailable: "Источник временно недоступен. Попробуйте ещё раз позже.",
  provider_rate_limited: "Лимит запросов источника исчерпан. Дождитесь указанного времени повтора.",
  provider_access_restricted: "Источник ограничил доступ. Сохранённые матчи остаются доступны.",
  invalid_provider_response: "Источник вернул некорректные данные. Сохранённые данные не изменены.",
  database_not_configured: "База данных не настроена. Укажите DATABASE_URL для локального сервиса.",
  service_unavailable: "Сервис недоступен. Проверьте запуск базы данных и повторите запрос.",
  invalid_match_filters: "Проверьте период и значения фильтров.",
  invalid_match_cursor: "Список изменился или ссылка продолжения неверна. Примените фильтры заново.",
  history_interrupted: "Обновление прервано. Запустите его повторно.",
  participant_account_conflict: "Источник вернул конфликтующие данные участника. Страница не сохранена.",
};
export function sourceError(code: string): string {return messages[code] ?? "Не удалось выполнить запрос. Попробуйте ещё раз.";}
export async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url,options); const body=await response.json();
  if(!response.ok) throw new Error(sourceError(body.error)+(body.retryAfter?` Повтор через ${body.retryAfter} сек.`:""));
  return body as T;
}
