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
        </div>
      </ScrollArea>
    </div>
  );
};
