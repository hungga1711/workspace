/** Asking for a task in a chat: "tạo task …", "tạo việc …", "create a task …" (and "giao cho agent …"). */
export const TASK_INTENT =
  /^\s*(@ai\s+)?((hãy\s+)?tạo\s+(giúp\s+(tôi|mình)\s+)?(một\s+|1\s+)?(task|việc|công việc)|giao\s+(việc\s+)?cho\s+(ai\s+)?agent|create\s+(a\s+)?task|add\s+(a\s+)?task|make\s+(a\s+)?task)\b/i;
