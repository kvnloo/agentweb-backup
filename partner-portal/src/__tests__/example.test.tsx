import React from 'react';
import { render, screen } from '@testing-library/react';

// Simple test component
const TestComponent = ({ message }: { message: string }) => {
  return <div data-testid="test-message">{message}</div>;
};

describe('Partner Portal Tests', () => {
  it('should render a test component', () => {
    render(<TestComponent message="Hello Jest!" />);
    
    const element = screen.getByTestId('test-message');
    expect(element).toBeInTheDocument();
    expect(element).toHaveTextContent('Hello Jest!');
  });

  it('should handle basic math operations', () => {
    expect(2 + 2).toBe(4);
    expect(10 - 5).toBe(5);
    expect(3 * 3).toBe(9);
  });

  it('should work with arrays', () => {
    const testArray = [1, 2, 3, 4, 5];
    expect(testArray).toHaveLength(5);
    expect(testArray).toContain(3);
    expect(testArray[0]).toBe(1);
  });

  it('should work with objects', () => {
    const testObject = {
      name: 'AgentWeb',
      version: '1.0.0',
      features: ['automation', 'testing']
    };
    
    expect(testObject).toHaveProperty('name');
    expect(testObject.name).toBe('AgentWeb');
    expect(testObject.features).toContain('automation');
  });
});
