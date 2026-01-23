import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import McpServersTab from '../McpServersTab';
import axios from 'axios';

// Mock axios
jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

// Mock AuthContext
jest.mock('../../../contexts/AuthContext', () => ({
  useAuth: () => ({
    token: 'fake-token',
  }),
}));

// Mock config
jest.mock('../../../config', () => ({
  buildApiUrl: (path: string) => `http://localhost:3000${path}`,
}));

describe('McpServersTab', () => {
    const mockServers = [
        {
            name: 'server1',
            transport: 'streamable-http',
            url: 'http://localhost:8080/mcp',
            discoveredTools: ['tool1', 'tool2']
        },
        {
            name: 'server2',
            transport: 'sse',
            url: 'http://localhost:8081/sse',
            discoveredTools: []
        }
    ];

    beforeEach(() => {
        jest.resetAllMocks();
    });

    it('renders loading state initially', async () => {
        // returning a promise that never resolves for this test to keep loading state? 
        // Or just checking if it renders before waiting.
        // Let's rely on standard async flow
        mockedAxios.get.mockResolvedValueOnce({ data: [] });
        
        render(<McpServersTab />);
        // Checking for circular progress. Since it might disappear quickly, 
        // we might not catch it if we await immediately. 
        // But usually un-awaited it's there.
        // Alternatively, finding by role 'progressbar' usually works for CircularProgress
        expect(screen.getByRole('progressbar')).toBeInTheDocument();

        await waitFor(() => {
             expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
        });
    });

    it('renders empty state when no servers return', async () => {
        mockedAxios.get.mockResolvedValueOnce({ data: [] });

        render(<McpServersTab />);

        await waitFor(() => {
            expect(screen.getByText('No MCP servers configured')).toBeInTheDocument();
        });
    });

    it('renders list of servers', async () => {
        mockedAxios.get.mockResolvedValueOnce({ data: mockServers });

        render(<McpServersTab />);

        await waitFor(() => {
            expect(screen.getByText('server1')).toBeInTheDocument();
            expect(screen.getByText('server2')).toBeInTheDocument();
            expect(screen.getByText('streamable-http')).toBeInTheDocument();
            expect(screen.getByText('sse')).toBeInTheDocument();
        });
    });

    it('handles load failure', async () => {
        mockedAxios.get.mockRejectedValueOnce({ 
            response: { data: { message: 'Failed to fetch' } } 
        });

        render(<McpServersTab />);

        await waitFor(() => {
            expect(screen.getByText('Failed to fetch')).toBeInTheDocument();
        });
    });

    it('can add a new server', async () => {
        mockedAxios.get.mockResolvedValueOnce({ data: [] }); // Initial load
        
        render(<McpServersTab />);
        await waitFor(() => expect(screen.queryByRole('progressbar')).not.toBeInTheDocument());

        // Open Dialog
        fireEvent.click(screen.getByText('Add Server'));
        expect(screen.getByText('Add MCP Server')).toBeInTheDocument();

        // Fill Form
        fireEvent.change(screen.getByLabelText(/Server Name/i), { target: { value: 'new-server' } });
        const transportCombobox = screen.getByRole('combobox', { hidden: true }); // MUI Select sometimes hides the input
        // Or simpler, try to find by label text effectively
        // Providing a more robust way for MUI v5 Select:
        fireEvent.mouseDown(screen.getByRole('combobox'));
        const listbox = screen.getByRole('listbox');
        fireEvent.click(within(listbox).getByText('Streamable HTTP'));
        
        // After selecting transport, URL field appears
        fireEvent.change(screen.getByLabelText(/URL/i), { target: { value: 'http://new-mcp' } });

        // Mock add response
        mockedAxios.post.mockResolvedValueOnce({}); 
        // Mock discover response (called after add)
        mockedAxios.post.mockResolvedValueOnce({ data: { count: 5 } });
        // Mock reload (called after discover)
        mockedAxios.get.mockResolvedValueOnce({ 
            data: [{ name: 'new-server', transport: 'streamable-http', url: 'http://new-mcp', discoveredTools: ['t1'] }] 
        });

        // Submit
        fireEvent.click(screen.getByRole('button', { name: 'Add' }));

        await waitFor(() => {
            expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        });

        // Verify API calls
        expect(mockedAxios.post).toHaveBeenCalledTimes(2); // Add + Discover
        expect(mockedAxios.post).toHaveBeenNthCalledWith(1, 
            'http://localhost:3000/api/admin/mcp-servers', 
            expect.objectContaining({
                name: 'new-server',
                transport: 'streamable-http',
                url: 'http://new-mcp'
            }),
            expect.any(Object)
        );
        expect(mockedAxios.post).toHaveBeenNthCalledWith(2, 
            'http://localhost:3000/api/admin/mcp-servers/new-server/discover-tools', 
            {},
            expect.any(Object)
        );

        // Verify loaded
        expect(mockedAxios.get).toHaveBeenCalledTimes(2);
    });

    it('can delete a server', async () => {
        mockedAxios.get.mockResolvedValueOnce({ data: mockServers }); // Initial load
        
        render(<McpServersTab />);
        await waitFor(() => expect(screen.getByText('server1')).toBeInTheDocument());

        // Click delete on first server
        const deleteParams = screen.getAllByTitle('Delete');
        fireEvent.click(deleteParams[0]);

        expect(screen.getByText('Delete MCP Server')).toBeInTheDocument();
        expect(screen.getByText('Are you sure you want to delete the server "server1"?')).toBeInTheDocument();

        mockedAxios.delete.mockResolvedValueOnce({});
        mockedAxios.get.mockResolvedValueOnce({ data: [mockServers[1]] }); // Reload with one less

        fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

        await waitFor(() => {
            expect(screen.getByText('Server deleted successfully')).toBeInTheDocument();
        });

        expect(mockedAxios.delete).toHaveBeenCalledWith(
            'http://localhost:3000/api/admin/mcp-servers/server1',
            expect.any(Object)
        );
    });

    it('can discover tools', async () => {
        mockedAxios.get.mockResolvedValueOnce({ data: mockServers }); 
        
        render(<McpServersTab />);
        await waitFor(() => expect(screen.getByText('server1')).toBeInTheDocument());

        // Find "X Tools" button for server1
        const discoverBtn = screen.getByText('2 Tools'); // Assuming server1 has 2 tools
        // Mock discovery and reload BEFORE action
        mockedAxios.post.mockResolvedValueOnce({ data: { count: 3 } });
        mockedAxios.get.mockResolvedValueOnce({ data: mockServers }); // Reload

        fireEvent.click(discoverBtn);

        await waitFor(() => {
            // It might trigger a loading state on the button
             expect(mockedAxios.post).toHaveBeenCalledWith(
                'http://localhost:3000/api/admin/mcp-servers/server1/discover-tools',
                {},
                expect.any(Object)
            );
        });

         await waitFor(() => {
            expect(screen.getByText('Discovered 3 tools from server1')).toBeInTheDocument();
         });
    });

    it('can edit a server', async () => {
         mockedAxios.get.mockResolvedValueOnce({ data: mockServers }); 
        
        render(<McpServersTab />);
        await waitFor(() => expect(screen.getByText('server1')).toBeInTheDocument());

        // Click edit
        const editButtons = screen.getAllByTitle('Edit');
        fireEvent.click(editButtons[0]);

        expect(screen.getByText('Edit MCP Server')).toBeInTheDocument();
        
        const urlInput = screen.getByLabelText(/URL/i);
        expect(urlInput).toHaveValue('http://localhost:8080/mcp');

        fireEvent.change(urlInput, { target: { value: 'http://updated-url' } });

        mockedAxios.put.mockResolvedValueOnce({});
        mockedAxios.get.mockResolvedValueOnce({ 
            data: [{ ...mockServers[0], url: 'http://updated-url' }, mockServers[1]] 
        });

        fireEvent.click(screen.getByRole('button', { name: 'Save' }));

        await waitFor(() => {
             expect(screen.getByText('Server updated successfully')).toBeInTheDocument();
        });

        expect(mockedAxios.put).toHaveBeenCalledWith(
            'http://localhost:3000/api/admin/mcp-servers/server1',
            expect.objectContaining({ url: 'http://updated-url' }),
            expect.any(Object)
        );
    });

});
