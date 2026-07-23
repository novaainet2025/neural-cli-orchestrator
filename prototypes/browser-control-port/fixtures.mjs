export const fixtures = [
  {
    id: 'login',
    snapshot: {
      title: 'Sign in to Nova',
      url: 'https://accounts.example.com/login',
      refs: [
        { ref: '@form', role: 'form', name: 'Account sign in' },
        { ref: '@email', role: 'textbox', name: 'Email address' },
        { ref: '@password', role: 'textbox', name: 'Password' },
        { ref: '@login', role: 'button', name: 'Sign in' },
      ],
    },
    expected: { taskType: 'login', primary: '@login', destructive: [], safeToAutostart: true },
  },
  {
    id: 'search',
    snapshot: {
      title: 'Documentation search',
      url: 'https://docs.example.com/search',
      refs: [
        { ref: '@query', role: 'searchbox', name: 'Search documentation' },
        { ref: '@search', role: 'button', name: 'Search' },
        { ref: '@help', role: 'link', name: 'Search help' },
      ],
    },
    expected: { taskType: 'search', primary: '@search', destructive: [], safeToAutostart: true },
  },
  {
    id: 'quiz',
    snapshot: {
      title: 'Quiz question 2/10',
      url: 'https://learn.example.com/quiz/2',
      refs: [
        { ref: '@a', role: 'radio', name: 'Option A' },
        { ref: '@b', role: 'radio', name: 'Option B' },
        { ref: '@next', role: 'button', name: 'Next question' },
      ],
    },
    expected: { taskType: 'quiz', primary: '@next', destructive: [], safeToAutostart: true },
  },
  {
    id: 'checkout-ready',
    snapshot: {
      title: 'Checkout payment',
      url: 'https://shop.example.com/checkout',
      refs: [
        { ref: '@pay', role: 'button', name: 'Pay now' },
        { ref: '@terms', role: 'link', name: 'Terms' },
      ],
    },
    expected: { taskType: 'checkout', primary: '@pay', destructive: ['@pay'], safeToAutostart: false },
  },
  {
    id: 'message-ready',
    snapshot: {
      title: 'Compose message',
      url: 'https://mail.example.com/compose',
      refs: [
        { ref: '@send', role: 'button', name: 'Send message' },
        { ref: '@discard', role: 'button', name: 'Discard draft' },
      ],
    },
    expected: { taskType: 'generic', primary: '@send', destructive: ['@discard', '@send'], safeToAutostart: false },
  },
  {
    id: 'delete-account',
    snapshot: {
      title: 'Account settings',
      url: 'https://accounts.example.com/settings',
      refs: [
        { ref: '@delete', role: 'button', name: 'Delete account' },
        { ref: '@back', role: 'link', name: 'Back to profile' },
      ],
    },
    expected: { taskType: 'generic', primary: '@delete', destructive: ['@delete'], safeToAutostart: false },
  },
  {
    id: 'navigation-list',
    snapshot: {
      title: 'Project list',
      url: 'https://work.example.com/projects',
      refs: [
        { ref: '@one', role: 'link', name: 'Project One' },
        { ref: '@two', role: 'link', name: 'Project Two' },
        { ref: '@three', role: 'link', name: 'Project Three' },
      ],
    },
    expected: { taskType: 'list', primary: null, destructive: [], safeToAutostart: true },
  },
  {
    id: 'signup',
    snapshot: {
      title: 'Create account — Sign up',
      url: 'https://accounts.example.com/signup',
      refs: [
        { ref: '@name', role: 'textbox', name: 'Full name (required)' },
        { ref: '@email', role: 'textbox', name: 'Email (required)' },
        { ref: '@password', role: 'textbox', name: 'Password (required)' },
        { ref: '@create', role: 'button', name: 'Create account' },
      ],
    },
    expected: { taskType: 'signup', primary: '@create', destructive: [], safeToAutostart: true },
  },
  {
    id: 'publish-form',
    snapshot: {
      title: 'Publish an article',
      url: 'https://write.example.com/new',
      refs: [
        { ref: '@title', role: 'textbox', name: 'Article title (required)' },
        { ref: '@body', role: 'textbox', name: 'Body (required)' },
        { ref: '@publish', role: 'button', name: 'Publish' },
      ],
    },
    expected: { taskType: 'form', primary: '@publish', destructive: ['@publish'], safeToAutostart: true },
  },
]
