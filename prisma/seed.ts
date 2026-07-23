import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding database...');

  const passwordHash = await bcrypt.hash('password123', 10);

  const alex = await prisma.user.upsert({
    where: { email: 'alex@example.com' },
    update: {},
    create: {
      fullName: 'Alex Johnson',
      email: 'alex@example.com',
      passwordHash,
      bio: 'Computer Science student passionate about AI and machine learning.',
      university: 'University of Technology',
      studyLevel: 'UNDERGRADUATE',
    },
  });

  const priya = await prisma.user.upsert({
    where: { email: 'priya@example.com' },
    update: {},
    create: {
      fullName: 'Priya Sharma',
      email: 'priya@example.com',
      passwordHash,
      bio: 'Postgraduate student specialising in Data Science.',
      university: 'National University',
      studyLevel: 'POSTGRADUATE',
    },
  });

  const jordan = await prisma.user.upsert({
    where: { email: 'jordan@example.com' },
    update: {},
    create: {
      fullName: 'Jordan Lee',
      email: 'jordan@example.com',
      passwordHash,
      bio: 'Self-learner exploring web development and design.',
      studyLevel: 'SELF_LEARNER',
    },
  });

  await prisma.friendship.upsert({
    where: { requesterId_addresseeId: { requesterId: alex.id, addresseeId: priya.id } },
    update: {},
    create: { requesterId: alex.id, addresseeId: priya.id, status: 'ACCEPTED' },
  });
  await prisma.friendship.upsert({
    where: { requesterId_addresseeId: { requesterId: alex.id, addresseeId: jordan.id } },
    update: {},
    create: { requesterId: alex.id, addresseeId: jordan.id, status: 'ACCEPTED' },
  });

  const dsa = await prisma.subject.create({
    data: {
      name: 'Data Structures & Algorithms',
      description: 'Core CS concepts including arrays, linked lists, trees, graphs, and algorithm analysis.',
      visibility: 'FRIENDS_ONLY',
      allowCopy: true,
      ownerId: alex.id,
    },
  });
  const dbms = await prisma.subject.create({
    data: {
      name: 'Database Management Systems',
      description: 'Relational databases, SQL, normalization, transactions, and NoSQL databases.',
      visibility: 'PUBLIC',
      allowCopy: true,
      ownerId: alex.id,
    },
  });
  const se = await prisma.subject.create({
    data: {
      name: 'Software Engineering',
      description: 'Software development lifecycle, design patterns, agile methodology, and testing.',
      visibility: 'PRIVATE',
      allowCopy: false,
      ownerId: alex.id,
    },
  });

  const arraysTopic = await prisma.topic.create({
    data: {
      subjectId: dsa.id,
      name: 'Arrays & Linked Lists',
      description: 'Fundamental data structures — operations, complexity analysis.',
      visibility: 'FRIENDS_ONLY',
      allowCopy: true,
    },
  });
  const sqlTopic = await prisma.topic.create({
    data: {
      subjectId: dbms.id,
      name: 'SQL Fundamentals',
      description: 'SELECT, JOIN, GROUP BY, subqueries and query optimization.',
      visibility: 'PUBLIC',
      allowCopy: true,
    },
  });
  const patternsTopic = await prisma.topic.create({
    data: {
      subjectId: se.id,
      name: 'Design Patterns',
      description: 'Creational, structural, and behavioural design patterns with examples.',
      visibility: 'PRIVATE',
      allowCopy: false,
    },
  });

  const dsaQuiz = await prisma.quiz.create({
    data: {
      title: 'Arrays & Linked Lists Quiz',
      subjectId: dsa.id,
      topicId: arraysTopic.id,
      visibility: 'FRIENDS_ONLY',
      allowCopy: true,
      ownerId: alex.id,
      questions: {
        create: [
          {
            order: 0,
            text: 'What is the time complexity of accessing an element in an array by index?',
            optionA: 'O(n)', optionB: 'O(log n)', optionC: 'O(1)', optionD: 'O(n²)',
            correctAnswer: 'C',
            explanation: 'Array access by index is O(1) because arrays use contiguous memory.',
          },
          {
            order: 1,
            text: 'Which data structure uses LIFO ordering?',
            optionA: 'Queue', optionB: 'Stack', optionC: 'Linked List', optionD: 'Tree',
            correctAnswer: 'B',
            explanation: 'A Stack uses Last In, First Out ordering.',
          },
          {
            order: 2,
            text: 'What is the main advantage of a linked list over an array?',
            optionA: 'Faster random access', optionB: 'Less memory usage',
            optionC: 'Dynamic size without reallocation', optionD: 'Better cache performance',
            correctAnswer: 'C',
            explanation: 'Linked lists can grow or shrink dynamically.',
          },
          {
            order: 3,
            text: 'Time complexity of inserting at the head of a singly linked list?',
            optionA: 'O(n)', optionB: 'O(log n)', optionC: 'O(n²)', optionD: 'O(1)',
            correctAnswer: 'D',
            explanation: 'Just update the head pointer.',
          },
          {
            order: 4,
            text: 'Which is NOT a property of a doubly linked list?',
            optionA: 'Next pointer', optionB: 'Prev pointer', optionC: 'O(1) access by index', optionD: 'Bidirectional traversal',
            correctAnswer: 'C',
            explanation: 'Doubly linked lists still require O(n) traversal to reach an index.',
          },
        ],
      },
    },
    include: { questions: true },
  });

  const sqlQuiz = await prisma.quiz.create({
    data: {
      title: 'SQL Fundamentals Test',
      subjectId: dbms.id,
      topicId: sqlTopic.id,
      visibility: 'PUBLIC',
      allowCopy: true,
      ownerId: alex.id,
      questions: {
        create: [
          {
            order: 0,
            text: 'What does SQL stand for?',
            optionA: 'Structured Query Language', optionB: 'Simple Query Language',
            optionC: 'Standard Query Language', optionD: 'Sequential Query Language',
            correctAnswer: 'A',
            explanation: 'SQL stands for Structured Query Language.',
          },
          {
            order: 1,
            text: 'Which SQL clause filters records?',
            optionA: 'ORDER BY', optionB: 'GROUP BY', optionC: 'WHERE', optionD: 'HAVING',
            correctAnswer: 'C',
            explanation: 'WHERE filters rows before grouping.',
          },
          {
            order: 2,
            text: 'Which JOIN returns all rows from both tables?',
            optionA: 'INNER JOIN', optionB: 'LEFT JOIN', optionC: 'RIGHT JOIN', optionD: 'FULL OUTER JOIN',
            correctAnswer: 'D',
            explanation: 'FULL OUTER JOIN returns all rows from both tables.',
          },
        ],
      },
    },
    include: { questions: true },
  });

  await prisma.quiz.create({
    data: {
      title: 'Design Patterns Mastery',
      subjectId: se.id,
      topicId: patternsTopic.id,
      visibility: 'PRIVATE',
      allowCopy: false,
      ownerId: alex.id,
      questions: {
        create: [
          {
            order: 0,
            text: 'Which pattern ensures only one instance of a class exists?',
            optionA: 'Factory', optionB: 'Observer', optionC: 'Singleton', optionD: 'Strategy',
            correctAnswer: 'C',
            explanation: 'Singleton restricts instantiation to a single instance.',
          },
        ],
      },
    },
  });

  const attempt = await prisma.quizAttempt.create({
    data: {
      quizId: dsaQuiz.id,
      userId: alex.id,
      correctCount: 4,
      totalQuestions: 5,
      scorePercent: 80,
      timeTakenSeconds: 480,
      answers: {
        create: dsaQuiz.questions.map((q, i) => ({
          questionId: q.id,
          selectedAnswer: q.correctAnswer,
          isCorrect: i !== 4,
        })),
      },
    },
  });

  await prisma.spacedRepetition.create({
    data: {
      userId: alex.id,
      quizId: dsaQuiz.id,
      topicId: arraysTopic.id,
      lastScore: 80,
      intervalDays: 3,
      nextRevisionDate: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
    },
  });

  await prisma.notification.createMany({
    data: [
      {
        userId: alex.id,
        title: 'Quiz Due for Revision',
        message: 'Arrays & Linked Lists Quiz is due for review. Keep your streak going!',
        type: 'REMINDER',
        relatedId: dsaQuiz.id,
      },
      {
        userId: alex.id,
        title: 'Quiz Completed Successfully',
        message: 'You scored 80% on Arrays & Linked Lists Quiz. Great job!',
        type: 'QUIZ',
        relatedId: dsaQuiz.id,
        isRead: true,
      },
    ],
  });

  const exam = await prisma.exam.create({
    data: {
      title: 'Midterm — Data Structures',
      subjectId: dsa.id,
      topicId: arraysTopic.id,
      type: 'FRIEND_EXAM',
      status: 'SCHEDULED',
      durationMinutes: 60,
      startTime: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
      organizerId: alex.id,
      questions: {
        create: dsaQuiz.questions.map((q, i) => ({
          order: i,
          text: q.text,
          optionA: q.optionA,
          optionB: q.optionB,
          optionC: q.optionC,
          optionD: q.optionD,
          correctAnswer: q.correctAnswer,
          explanation: q.explanation,
        })),
      },
      participants: {
        create: [{ userId: alex.id }, { userId: priya.id }],
      },
    },
  });

  console.log('Seed complete:');
  console.log(`  Users: alex@example.com / priya@example.com / jordan@example.com (password: password123)`);
  console.log(`  Subjects: ${dsa.name}, ${dbms.name}, ${se.name}`);
  console.log(`  Quizzes: ${dsaQuiz.title}, ${sqlQuiz.title}`);
  console.log(`  Exam: ${exam.title}`);
  console.log(`  Attempt id: ${attempt.id}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
