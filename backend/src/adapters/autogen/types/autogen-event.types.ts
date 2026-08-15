// AutoGen's own event shapes — a conversational message-passing model
// (agent <-> agent, and group chats orchestrated among N agents), unlike
// LangChain's run_id-correlated callbacks or CrewAI's Crew/Task hierarchy.

interface AutoGenEventBase {
  conversation_id: string;
  timestamp: string;
}

export interface ConversationStartEvent extends AutoGenEventBase {
  type: "conversation_start";
  initiator_agent?: string;
}

export interface ConversationEndEvent extends AutoGenEventBase {
  type: "conversation_end";
}

export interface NestedConversationStartEvent extends AutoGenEventBase {
  type: "nested_conversation_start";
  parent_conversation_id: string;
  nesting_level: number;
}

export interface NestedConversationEndEvent extends AutoGenEventBase {
  type: "nested_conversation_end";
  parent_conversation_id: string;
  nesting_level: number;
}

export interface AgentMessageEvent extends AutoGenEventBase {
  type: "agent_message";
  sender_agent: string;
  receiver_agent: string;
  message_sequence_number: number;
  content?: string;
}

export interface FunctionCallEvent extends AutoGenEventBase {
  type: "function_call";
  call_id: string;
  sender_agent: string;
  function_name: string;
  arguments?: Record<string, unknown>;
}

export interface FunctionResultEvent extends AutoGenEventBase {
  type: "function_result";
  call_id: string;
  sender_agent: string;
  function_name: string;
  success: boolean;
  error?: { message: string; name?: string };
}

export interface GroupChatMessageEvent extends AutoGenEventBase {
  type: "group_chat_message";
  group_chat_id: string;
  sender_agent: string;
  participants: string[];
  orchestrator?: string;
  message_sequence_number: number;
}

export type AutoGenEvent =
  | ConversationStartEvent
  | ConversationEndEvent
  | NestedConversationStartEvent
  | NestedConversationEndEvent
  | AgentMessageEvent
  | FunctionCallEvent
  | FunctionResultEvent
  | GroupChatMessageEvent;

/** What arrives at POST /api/v1/adapters/autogen/telemetry — same envelope-wrapping reasoning as LangChain/CrewAI (agent_id/tenant_id aren't AutoGen concepts). */
export interface AutoGenTelemetryEnvelope {
  agent_id: string;
  tenant_id: string;
  adapter_version: string;
  event: AutoGenEvent;
}
