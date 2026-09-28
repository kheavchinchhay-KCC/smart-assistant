// supabase/functions/telegram-webhook/types.ts
// Minimal subset of the Telegram Bot API types actually used here.
// See https://core.telegram.org/bots/api for the full schema.

export interface TgUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

export interface TgChat {
  id: number;
  type: string;
}

export interface TgPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: TgChat;
  date: number;
  text?: string;
  photo?: TgPhotoSize[];
  caption?: string;
}

export interface TgCallbackQuery {
  id: string;
  from: TgUser;
  message?: TgMessage;
  data?: string;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

export interface InlineKeyboardButton {
  text: string;
  callback_data?: string;
  web_app?: { url: string };
}

export type InlineKeyboard = InlineKeyboardButton[][];

export interface ReplyKeyboard {
  keyboard: string[][];
  resize_keyboard: boolean;
  one_time_keyboard?: boolean;
}

/** Everything a handler needs about "who is talking to us right now". */
export interface BotContext {
  chatId: number;
  telegramId: number;
  tgUser: TgUser;
  appUser: {
    id: string;
    display_name: string;
    role: "ADMIN" | "USER";
    status: string;
    language: "en" | "kh";
    timezone: string;
    expires_at: string | null;
  };
}
