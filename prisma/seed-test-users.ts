import { PrismaClient, StudyLevel, Visibility } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

const USER_COUNT = 100;
const SUBJECTS_PER_USER = 6;
const TOPICS_PER_SUBJECT = 2;
const QUIZZES_PER_TOPIC = 2;
const TEST_PASSWORD = 'test@123';
const TEST_EMAIL_PREFIX = 'seed.user';
const TEST_EMAIL_DOMAIN = '@smartstudy.test';

const subjectCatalog = [
  ['Mathematics', 'Core mathematical reasoning and problem solving'],
  ['Computer Science', 'Programming, algorithms, and computing concepts'],
  ['Physics', 'Mechanics, energy, waves, and modern physics'],
  ['Chemistry', 'Matter, reactions, bonding, and laboratory concepts'],
  ['Biology', 'Cells, genetics, organisms, and ecosystems'],
  ['English', 'Language, writing, comprehension, and literature'],
] as const;

const studyLevels: StudyLevel[] = [
  'SCHOOL',
  'UNDERGRADUATE',
  'POSTGRADUATE',
  'SELF_LEARNER',
];

function shuffledVisibilities(userNumber: number): Visibility[] {
  const values: Visibility[] = [
    'PUBLIC',
    'PUBLIC',
    'FRIENDS_ONLY',
    'FRIENDS_ONLY',
    'PRIVATE',
    'PRIVATE',
  ];

  // Deterministic shuffle: realistic variety while keeping the seed repeatable.
  let state = userNumber * 9301 + 49297;
  for (let index = values.length - 1; index > 0; index--) {
    state = (state * 233280 + 49297) % 233280;
    const swapIndex = state % (index + 1);
    [values[index], values[swapIndex]] = [values[swapIndex], values[index]];
  }
  return values;
}

function questions(subjectName: string, topicNumber: number, quizNumber: number) {
  return [
    {
      order: 0,
      text: `Which statement best describes a key idea in ${subjectName} topic ${topicNumber}?`,
      optionA: 'It applies the main concept correctly',
      optionB: 'It ignores the available evidence',
      optionC: 'It changes the subject completely',
      optionD: 'It cannot be evaluated',
      correctAnswer: 'A' as const,
      explanation: `Option A correctly applies the main idea from ${subjectName} topic ${topicNumber}.`,
    },
    {
      order: 1,
      text: `What is the best first step when solving quiz ${quizNumber} problems in ${subjectName}?`,
      optionA: 'Guess immediately',
      optionB: 'Identify the known facts and required result',
      optionC: 'Skip every difficult detail',
      optionD: 'Choose the longest answer',
      correctAnswer: 'B' as const,
      explanation: 'Identifying what is known and what is required gives the problem a clear structure.',
    },
    {
      order: 2,
      text: `How should a learner verify an answer in ${subjectName}?`,
      optionA: 'Check the reasoning against the topic principles',
      optionB: 'Assume the first answer is correct',
      optionC: 'Ignore contradictory results',
      optionD: 'Use an unrelated method',
      correctAnswer: 'A' as const,
      explanation: 'Verification should compare the reasoning and result with the relevant principles.',
    },
  ];
}

async function main() {
  console.log(`Replacing ${USER_COUNT} generated Smart Study test users...`);

  await prisma.user.deleteMany({
    where: {
      email: {
        startsWith: TEST_EMAIL_PREFIX,
        endsWith: TEST_EMAIL_DOMAIN,
      },
    },
  });

  const passwordHash = await bcrypt.hash(TEST_PASSWORD, 10);

  for (let userIndex = 1; userIndex <= USER_COUNT; userIndex++) {
    const paddedNumber = String(userIndex).padStart(3, '0');
    const visibilities = shuffledVisibilities(userIndex);

    await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
        fullName: `Test Student ${paddedNumber}`,
        email: `${TEST_EMAIL_PREFIX}${paddedNumber}${TEST_EMAIL_DOMAIN}`,
        passwordHash,
        university: `Smart Study University ${(userIndex % 5) + 1}`,
        studyLevel: studyLevels[(userIndex - 1) % studyLevels.length],
        bio: `Generated Smart Study test account ${paddedNumber}.`,
        },
      });

      for (const [subjectIndex, [name, description]] of subjectCatalog
        .slice(0, SUBJECTS_PER_USER)
        .entries()) {
        const visibility = visibilities[subjectIndex];
        const subject = await tx.subject.create({
          data: {
              name,
              description,
              visibility,
              allowCopy: visibility !== 'PRIVATE',
              ownerId: user.id,
          },
        });

        for (let topicIndex = 0; topicIndex < TOPICS_PER_SUBJECT; topicIndex++) {
          const topic = await tx.topic.create({
            data: {
              subjectId: subject.id,
              name: `${name} Topic ${topicIndex + 1}`,
              description: `Study material for ${name}, topic ${topicIndex + 1}.`,
              visibility,
              allowCopy: visibility !== 'PRIVATE',
            },
          });

          for (let quizIndex = 0; quizIndex < QUIZZES_PER_TOPIC; quizIndex++) {
            await tx.quiz.create({
              data: {
                title: `${name} Topic ${topicIndex + 1} Quiz ${quizIndex + 1}`,
                subjectId: subject.id,
                topicId: topic.id,
                ownerId: user.id,
                visibility,
                allowCopy: visibility !== 'PRIVATE',
                questions: {
                  create: questions(name, topicIndex + 1, quizIndex + 1),
                },
              },
            });
          }
        }
      }
    });

    if (userIndex % 10 === 0) {
      console.log(`  Created ${userIndex}/${USER_COUNT} users`);
    }
  }

  console.log('Test-user seed complete.');
  console.log(`  Users: ${USER_COUNT}`);
  console.log(`  Subjects: ${USER_COUNT * SUBJECTS_PER_USER}`);
  console.log(`  Topics: ${USER_COUNT * SUBJECTS_PER_USER * TOPICS_PER_SUBJECT}`);
  console.log(`  Quizzes: ${USER_COUNT * SUBJECTS_PER_USER * TOPICS_PER_SUBJECT * QUIZZES_PER_TOPIC}`);
  console.log(`  Login example: ${TEST_EMAIL_PREFIX}001${TEST_EMAIL_DOMAIN} / ${TEST_PASSWORD}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
