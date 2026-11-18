/**
 * Сколько задач API сейчас в работе. Отдельный модуль без зависимостей:
 * его читает загрузчик сайта (общий потолок сервера), а пишет очередь API,
 * которая сама зависит от загрузчика, — так нет циклического импорта.
 */

let activeApiJobs = 0

export function setActiveApiJobs(count: number): void {
  activeApiJobs = count
}

export function countActiveApiJobs(): number {
  return activeApiJobs
}
