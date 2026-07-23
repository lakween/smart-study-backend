// Converts between Prisma's UPPER_SNAKE enum values and the camelCase wire
// format the Flutter app's `fromString` parsers expect.

export function visibilityToDb(v: string): 'PRIVATE' | 'FRIENDS_ONLY' | 'PUBLIC' {
  switch (v) {
    case 'public':
      return 'PUBLIC';
    case 'friendsOnly':
      return 'FRIENDS_ONLY';
    default:
      return 'PRIVATE';
  }
}

export function visibilityFromDb(v: string): 'private' | 'friendsOnly' | 'public' {
  switch (v) {
    case 'PUBLIC':
      return 'public';
    case 'FRIENDS_ONLY':
      return 'friendsOnly';
    default:
      return 'private';
  }
}

export function studyLevelToDb(v: string): 'SCHOOL' | 'UNDERGRADUATE' | 'POSTGRADUATE' | 'SELF_LEARNER' {
  switch (v) {
    case 'school':
      return 'SCHOOL';
    case 'postgraduate':
      return 'POSTGRADUATE';
    case 'selfLearner':
      return 'SELF_LEARNER';
    default:
      return 'UNDERGRADUATE';
  }
}

export function studyLevelFromDb(v: string): 'school' | 'undergraduate' | 'postgraduate' | 'selfLearner' {
  switch (v) {
    case 'SCHOOL':
      return 'school';
    case 'POSTGRADUATE':
      return 'postgraduate';
    case 'SELF_LEARNER':
      return 'selfLearner';
    default:
      return 'undergraduate';
  }
}

export function documentTypeToDb(v: string): 'PDF' | 'JPG' | 'JPEG' | 'PNG' {
  return v.toUpperCase() as 'PDF' | 'JPG' | 'JPEG' | 'PNG';
}

export function documentTypeFromDb(v: string): 'pdf' | 'jpg' | 'jpeg' | 'png' {
  return v.toLowerCase() as 'pdf' | 'jpg' | 'jpeg' | 'png';
}

export function answerOptionToDb(v: string | null | undefined): 'A' | 'B' | 'C' | 'D' | null {
  if (!v) return null;
  return v.toUpperCase() as 'A' | 'B' | 'C' | 'D';
}

export function examTypeToDb(v: string): 'INDIVIDUAL' | 'FRIEND_EXAM' {
  return v === 'friendExam' ? 'FRIEND_EXAM' : 'INDIVIDUAL';
}

export function examTypeFromDb(v: string): 'individual' | 'friendExam' {
  return v === 'FRIEND_EXAM' ? 'friendExam' : 'individual';
}

export function examStatusToDb(v: string): 'DRAFT' | 'SCHEDULED' | 'STARTED' | 'COMPLETED' | 'CANCELLED' {
  return v.toUpperCase() as 'DRAFT' | 'SCHEDULED' | 'STARTED' | 'COMPLETED' | 'CANCELLED';
}

export function examStatusFromDb(v: string): 'draft' | 'scheduled' | 'started' | 'completed' | 'cancelled' {
  return v.toLowerCase() as 'draft' | 'scheduled' | 'started' | 'completed' | 'cancelled';
}

export function notificationTypeFromDb(v: string): 'quiz' | 'exam' | 'friend' | 'reminder' | 'ai' | 'general' {
  return v.toLowerCase() as 'quiz' | 'exam' | 'friend' | 'reminder' | 'ai' | 'general';
}

export function notificationTypeToDb(v: string): 'QUIZ' | 'EXAM' | 'FRIEND' | 'REMINDER' | 'AI' | 'GENERAL' {
  return v.toUpperCase() as 'QUIZ' | 'EXAM' | 'FRIEND' | 'REMINDER' | 'AI' | 'GENERAL';
}
