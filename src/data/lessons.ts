import catalog from '../../content/lessons.json'
import type { Lesson } from '../types'

export const LESSONS = catalog.entries as Lesson[]
export const CONTENT_TARGET = catalog.targetSize

export function findLesson(id: string): Lesson {
  return LESSONS.find((lesson) => lesson.id === id) ?? LESSONS[0]
}
