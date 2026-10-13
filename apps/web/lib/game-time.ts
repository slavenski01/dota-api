export const gameTime = (seconds: number) => `${seconds < 0 ? "−" : ""}${Math.floor(Math.abs(seconds) / 60)}:${String(Math.floor(Math.abs(seconds) % 60)).padStart(2, "0")}`;
