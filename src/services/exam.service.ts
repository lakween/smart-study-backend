import crypto from 'crypto';

export type ExamLifecycleStatus = 'DRAFT' | 'SCHEDULED' | 'STARTED' | 'COMPLETED' | 'CANCELLED';

export function shuffledIds(ids: string[]): string[] {
  const result = [...ids];
  for (let index = result.length - 1; index > 0; index--) {
    const swapIndex = crypto.randomInt(index + 1);
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

export function examDeadline(startedAt: Date, durationMinutes: number, closesAt?: Date | null): Date {
  const personalDeadline = new Date(startedAt.getTime() + durationMinutes * 60_000);
  if (!closesAt) return personalDeadline;
  return new Date(Math.min(personalDeadline.getTime(), closesAt.getTime()));
}

export function effectiveExamStatus(
  status: ExamLifecycleStatus,
  startsAt: Date | null,
  closesAt: Date | null,
  now = new Date()
): ExamLifecycleStatus {
  if (status === 'DRAFT' || status === 'CANCELLED' || status === 'COMPLETED') return status;
  if (closesAt && now >= closesAt) return 'COMPLETED';
  if (!startsAt || now >= startsAt) return 'STARTED';
  return 'SCHEDULED';
}

export function calculateExamScore(
  questions: Array<{ id: string; correctAnswer: string }>,
  answers: Array<{ questionId: string; selectedAnswer: string | null }>
) {
  const answerByQuestion = new Map(answers.map((answer) => [answer.questionId, answer.selectedAnswer]));
  const correctCount = questions.reduce(
    (total, question) => total + (answerByQuestion.get(question.id) === question.correctAnswer ? 1 : 0),
    0
  );
  const totalQuestions = questions.length;
  const scorePercent = totalQuestions === 0 ? 0 : (correctCount / totalQuestions) * 100;
  return { correctCount, totalQuestions, scorePercent };
}

export function canReleaseSolutions(input: {
  examType: 'INDIVIDUAL' | 'FRIEND_EXAM';
  releasePolicy: 'AFTER_SUBMISSION' | 'AFTER_CLOSE';
  examStatus: ExamLifecycleStatus;
  attemptSubmitted: boolean;
}): boolean {
  if (!input.attemptSubmitted) return false;
  if (input.releasePolicy === 'AFTER_SUBMISSION' && input.examType === 'INDIVIDUAL') return true;
  return input.examStatus === 'COMPLETED';
}
