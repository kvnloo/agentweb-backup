
import React, { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Mail, Plus, Trash } from "lucide-react";
import { toast } from "sonner";

export interface TaskSubscriber {
  email: string;
  subscribedOn: string;
}

interface SubscriberManagerProps {
  subscribers: TaskSubscriber[];
  onSubscribersChange: (subscribers: TaskSubscriber[]) => void;
}

export const SubscriberManager: React.FC<SubscriberManagerProps> = ({
  subscribers,
  onSubscribersChange
}) => {
  const [newSubscriberEmail, setNewSubscriberEmail] = useState("");

  const handleAddSubscriber = () => {
    if (!newSubscriberEmail || !newSubscriberEmail.includes('@')) {
      toast.error("Please enter a valid email");
      return;
    }

    const newSubscriber: TaskSubscriber = {
      email: newSubscriberEmail,
      subscribedOn: new Date().toISOString()
    };

    onSubscribersChange([...subscribers, newSubscriber]);
    setNewSubscriberEmail("");
    toast.success("Subscriber added");
  };

  const handleRemoveSubscriber = (email: string) => {
    onSubscribersChange(subscribers.filter(sub => sub.email !== email));
    toast.success("Subscriber removed");
  };

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleString();
  };

  return (
    <div>
      <h4 className="text-md font-medium mb-3">Subscribers</h4>
      <div className="space-y-4">
        <div className="flex gap-2">
          <div className="flex-grow">
            <Input 
              type="email" 
              placeholder="Email" 
              value={newSubscriberEmail}
              onChange={(e) => setNewSubscriberEmail(e.target.value)}
              className="w-full"
            />
          </div>
          <Button onClick={handleAddSubscriber}>
            <Plus className="h-4 w-4 mr-1" /> Add Subscriber
          </Button>
        </div>
        
        {subscribers.length > 0 ? (
          <div className="space-y-2">
            {subscribers.map((subscriber) => (
              <div key={subscriber.email} className="flex justify-between items-center p-3 bg-muted rounded-md">
                <div>
                  <div className="flex items-center">
                    <Mail className="h-4 w-4 mr-2" />
                    <span>{subscriber.email}</span>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Subscribed on {formatDate(subscriber.subscribedOn)}
                  </div>
                </div>
                <Button 
                  variant="ghost" 
                  size="icon" 
                  onClick={() => handleRemoveSubscriber(subscriber.email)}
                >
                  <Trash className="h-4 w-4 text-destructive" />
                </Button>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No subscribers found</p>
        )}
      </div>
    </div>
  );
};
