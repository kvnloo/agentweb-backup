
import { cn } from "@/lib/utils";
import { Message } from "@/types/chat";
import { ScrollArea } from "@/components/ui/scroll-area";

interface MessageListProps {
  messages: Message[];
}

export const MessageList = ({ messages }: MessageListProps) => {
  return (
    <div className="flex-1 h-full">
      <ScrollArea className="h-full">
        <div className="p-4 space-y-4">
          {messages.map((message) => (
            <div
              key={message.id}
              className={cn(
                "flex max-w-[80%] rounded-lg p-4",
                message.sender === "user" 
                  ? "bg-[#D6BCFA] text-black ml-auto" 
                  : "bg-[#F3EFFD] text-black mr-auto"
              )}
            >
              <div>
                <div className="text-sm">{message.content}</div>
                <div className="text-xs mt-1 text-gray-600">
                  {message.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </div>
              </div>
            </div>
          ))}
          {messages.length === 0 && <EmptyState />}
        </div>
      </ScrollArea>
    </div>
  );
};

const EmptyState = () => {
  return (
    <div className="flex flex-col items-center justify-center h-full text-center text-gray-700 py-20">
      <div className="w-16 h-16 rounded-full agent-gradient flex items-center justify-center mb-4">
        <span className="text-white text-2xl font-bold">E</span>
      </div>
      <h2 className="text-xl font-semibold text-gray-700">Emma</h2>
      <p className="max-w-sm mt-2">Your 24/7 marketing operator. Ask Emma to run market research, plan and optimize campaigns, or track performance metrics.</p>
    </div>
  );
};
