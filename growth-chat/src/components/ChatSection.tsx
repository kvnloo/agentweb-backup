
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { MessageCircle, Send, Sparkles } from "lucide-react";
import { useState } from "react";

const ChatSection = () => {
  const [message, setMessage] = useState("");
  const [messages, setMessages] = useState([
    {
      type: "system",
      content: "Welcome to Growth Genius! Ask me anything about startup growth strategies, and I'll share insights from 500+ successful companies."
    }
  ]);

  const handleSend = () => {
    if (!message.trim()) return;
    
    setMessages(prev => [...prev, 
      { type: "user", content: message },
      { type: "assistant", content: "I'm analyzing your question and searching through our database of successful startup strategies. This is a demo - the full chat will be available soon!" }
    ]);
    setMessage("");
  };

  return (
    <section className="min-h-screen bg-gradient-hero text-white flex items-center">
      <div className="container mx-auto px-4 py-8">
        <div className="max-w-4xl mx-auto">
          {/* Header */}
          <div className="text-center mb-8">
            <div className="flex items-center justify-center mb-4">
              <div className="bg-white/10 backdrop-blur-sm rounded-full p-4">
                <Sparkles className="w-8 h-8 text-energy" />
              </div>
            </div>
            <h1 className="text-4xl md:text-5xl font-bold mb-4">
              Growth Genius Chat
            </h1>
            <p className="text-xl text-white/80 max-w-2xl mx-auto">
              Get instant access to proven growth strategies from Silicon Valley's most successful startups
            </p>
          </div>

          {/* Chat Interface */}
          <Card className="bg-white/5 backdrop-blur-sm border-white/10 h-[500px] flex flex-col">
            <CardContent className="p-0 flex flex-col h-full">
              {/* Messages */}
              <ScrollArea className="flex-1 p-6">
                <div className="space-y-4">
                  {messages.map((msg, index) => (
                    <div key={index} className={`flex ${msg.type === 'user' ? 'justify-end' : 'justify-start'}`}>
                      <div className={`max-w-[80%] p-4 rounded-lg ${
                        msg.type === 'user' 
                          ? 'bg-growth text-white' 
                          : msg.type === 'system'
                          ? 'bg-white/10 text-white/90 border border-white/20'
                          : 'bg-white text-secondary'
                      }`}>
                        <p className="leading-relaxed">{msg.content}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </ScrollArea>

              {/* Input */}
              <div className="p-6 border-t border-white/10">
                <div className="flex gap-3">
                  <input
                    type="text"
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    onKeyPress={(e) => e.key === 'Enter' && handleSend()}
                    placeholder="Ask about growth strategies, user acquisition, retention..."
                    className="flex-1 px-4 py-3 rounded-lg bg-white/10 border border-white/20 text-white placeholder-white/60 focus:outline-none focus:ring-2 focus:ring-growth focus:border-transparent"
                  />
                  <Button 
                    onClick={handleSend}
                    className="bg-growth hover:bg-growth/90 text-white px-6"
                  >
                    <Send className="w-5 h-5" />
                  </Button>
                </div>
                <div className="mt-3 text-center">
                  <p className="text-sm text-white/60">
                    No credit card required • Free to start • 24/7 available
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Quick Start Prompts */}
          <div className="mt-8 grid grid-cols-1 md:grid-cols-3 gap-4">
            {[
              "How did Airbnb build trust?",
              "Show me viral growth tactics",
              "B2B SaaS growth strategies"
            ].map((prompt, index) => (
              <Button
                key={index}
                variant="outline"
                className="bg-white/5 border-white/20 text-white hover:bg-white/10 p-4 h-auto text-left"
                onClick={() => setMessage(prompt)}
              >
                <MessageCircle className="w-4 h-4 mr-2 flex-shrink-0" />
                {prompt}
              </Button>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
};

export default ChatSection;
