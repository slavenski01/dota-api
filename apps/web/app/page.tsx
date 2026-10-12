export default function HomePage() {
  return (
    <main>
      <p className="eyebrow">DOTA / РАЗБОР МАТЧЕЙ</p>
      <h1>Каждое решение<br />в контексте игры.</h1>
      <p className="intro">
        Карта, таймлайн и состояния героев помогут восстановить события матча
        и проверить решения по доступной игроку информации.
      </p>
      <section aria-labelledby="status-title">
        <p className="label">Состояние проекта</p>
        <h2 id="status-title">Сервис в разработке</h2>
        <p>Загрузка матчей и просмотр реплеев появятся на следующих этапах.</p>
      </section>
      <footer>Персональная аналитика Dota 2 · локальный запуск</footer>
    </main>
  );
}
