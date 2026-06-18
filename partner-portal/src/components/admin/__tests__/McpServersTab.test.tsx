
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
            expect(
              screen.getByText(/will restart the Agent Mode worker process/i)
            ).toBeInTheDocument();
        });
    });

    it('renders list of servers', async () => {
        mockedAxios.get.mockResolvedValueOnce({ data: [...mockServers, {
          name: 'local-stdio',
          transport: 'stdio',
          command: 'npx',
          url: 'test@example.com',
          discoveredTools: []
        }] });

        render(<McpServersTab />);

        await waitFor(() => {
            expect(screen.getByText('server1')).toBeInTheDocument();
            expect(screen.getByText('server2')).toBeInTheDocument();
            expect(screen.getByText('local-stdio')).toBeInTheDocument();
            expect(screen.getByText('streamable-http')).toBeInTheDocument();
            expect(screen.getByText('sse')).toBeInTheDocument();
            expect(screen.getByText('stdio')).toBeInTheDocument();
            // Stdio rows should prefer command display over url fallback
            expect(screen.getByText('npx')).toBeInTheDocument();
        });
    });

    it('shows a live auto-refresh countdown for OAuth servers', async () => {
        mockedAxios.get.mockResolvedValue({
            data: [{
                name: 'oauth-server',
                transport: 'streamable-http',
                url: 'https://mcp.example/mcp',
                authType: 'oauth',
                oauthHasRefreshToken: true,
                oauthExpiresAt: Date.now() + 30 * 60 * 1000, // 30 min out → ~25 min to refresh
                discoveredTools: [],
            }],
        });

        render(<McpServersTab />);

        await waitFor(() => expect(screen.getByText('oauth-server')).toBeInTheDocument());
        expect(screen.getByText(/Auto-refresh in/i)).toBeInTheDocument();
    });

    it('shows "Refreshing…" inside the refresh lead window', async () => {
        mockedAxios.get.mockResolvedValue({
            data: [{
                name: 'oauth-server',
                transport: 'streamable-http',
                url: 'https://mcp.example/mcp',
                authType: 'oauth',
                oauthHasRefreshToken: true,
                oauthExpiresAt: Date.now() + 2 * 60 * 1000, // 2 min left (< 5 min lead) → refreshing
                discoveredTools: [],
            }],
        });
        render(<McpServersTab />);
        await waitFor(() => expect(screen.getByText('oauth-server')).toBeInTheDocument());
        expect(screen.getByText(/Refreshing/i)).toBeInTheDocument();
    });

    it('prompts re-authorization when an OAuth token is expired with no refresh token', async () => {
        mockedAxios.get.mockResolvedValue({
            data: [{
                name: 'oauth-server',
                transport: 'streamable-http',
                url: 'https://mcp.example/mcp',
                authType: 'oauth',
                oauthHasRefreshToken: false,
                oauthExpiresAt: Date.now() - 60 * 1000, // already expired, cannot refresh
                discoveredTools: [],
            }],
        });
        render(<McpServersTab />);
        await waitFor(() => expect(screen.getByText('oauth-server')).toBeInTheDocument());
        expect(screen.getByText(/re-authorize/i)).toBeInTheDocument();
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

        // Or simpler, try to find by label text effectively
        // Providing a more robust way for MUI v5 Select:
        fireEvent.mouseDown(screen.getByRole('combobox'));
        const listbox = screen.getByRole('listbox');
        fireEvent.click(within(listbox).getByText('Streamable HTTP'));
        
        // After selecting transport, URL field appears
        fireEvent.change(screen.getByLabelText(/URL/i), { target: { value: 'http://new-mcp' } });

        // Mock add response
        mockedAxios.post.mockResolvedValueOnce({});
        // Mock OAuth initiate (HTTP servers are probed for OAuth before discovery).
        // No OAuth required here → proceed straight to discovery.
        mockedAxios.post.mockResolvedValueOnce({ data: { authorizationRequired: false } });
        // Mock discover response (called after the OAuth probe)
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

        // Verify API calls: Add + OAuth-probe + Discover
        await waitFor(() => expect(mockedAxios.post).toHaveBeenCalledTimes(3));
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
            'http://localhost:3000/api/admin/mcp-servers/new-server/oauth/initiate',
            {},
            expect.any(Object)
        );
        expect(mockedAxios.post).toHaveBeenNthCalledWith(3,
            'http://localhost:3000/api/admin/mcp-servers/new-server/discover-tools',
            {},
            expect.any(Object)
        );

        // Verify loaded
        expect(mockedAxios.get).toHaveBeenCalledTimes(2);
    });

    it('runs the OAuth popup flow when the server requires authorization', async () => {
        mockedAxios.get.mockResolvedValueOnce({ data: [] }); // Initial load

        render(<McpServersTab />);
        await waitFor(() => expect(screen.queryByRole('progressbar')).not.toBeInTheDocument());

        fireEvent.click(screen.getByText('Add Server'));
        fireEvent.change(screen.getByLabelText(/Server Name/i), { target: { value: 'oauth-srv' } });
        fireEvent.mouseDown(screen.getByRole('combobox'));
        fireEvent.click(within(screen.getByRole('listbox')).getByText('Streamable HTTP'));
        fireEvent.change(screen.getByLabelText(/URL/i), { target: { value: 'https://oauth-mcp' } });

        // add → ok; initiate → OAuth required (returns authorization URL)
        mockedAxios.post.mockResolvedValueOnce({});
        mockedAxios.post.mockResolvedValueOnce({
            data: { authorizationRequired: true, authorizationUrl: 'https://auth.example/authorize?x=1' },
        });
        // discover (after popup success) + reload
        mockedAxios.post.mockResolvedValueOnce({ data: { count: 2 } });
        mockedAxios.get.mockResolvedValueOnce({
            data: [{ name: 'oauth-srv', transport: 'streamable-http', url: 'https://oauth-mcp', authType: 'oauth', discoveredTools: ['a', 'b'] }],
        });

        const popup = { closed: false } as any;
        const openSpy = jest.spyOn(window, 'open').mockReturnValue(popup);

        fireEvent.click(screen.getByRole('button', { name: 'Add' }));

        // The provider login page should be opened in a popup.
        await waitFor(() =>
            expect(openSpy).toHaveBeenCalledWith('https://auth.example/authorize?x=1', 'mcp-oauth', expect.any(String))
        );

        // Simulate the backend callback posting a success message back to the opener.
        window.dispatchEvent(new MessageEvent('message', { data: { source: 'mcp-oauth', success: true } }));

        // After success, tool discovery runs for the newly-authorized server.
        await waitFor(() =>
            expect(mockedAxios.post).toHaveBeenCalledWith(
                'http://localhost:3000/api/admin/mcp-servers/oauth-srv/discover-tools',
                {},
                expect.any(Object)
            )
        );

        openSpy.mockRestore();
    });

    it('can add a stdio server with command, args, and env', async () => {
        mockedAxios.get.mockResolvedValueOnce({ data: [] }); // Initial load

        render(<McpServersTab />);
        await waitFor(() => expect(screen.queryByRole('progressbar')).not.toBeInTheDocument());

        fireEvent.click(screen.getByText('Add Server'));
        expect(screen.getByText('Add MCP Server')).toBeInTheDocument();

        fireEvent.change(screen.getByLabelText(/Server Name/i), { target: { value: 'brave-local' } });

        fireEvent.mouseDown(screen.getByRole('combobox'));
        const listbox = screen.getByRole('listbox');
        fireEvent.click(within(listbox).getByText('Stdio (Backend launches process)'));

        fireEvent.change(await screen.findByLabelText(/Command/i), { target: { value: 'npx' } });
        fireEvent.change(screen.getByLabelText(/Arguments \(optional, one per line\)/i), {
          target: { value: '-y\n@brave/brave-search-mcp-server\n--transport\nstdio' }
        });
        fireEvent.change(screen.getByLabelText(/Environment Variables JSON \(optional\)/i), {
          target: { value: '{"env":{"BRAVE_API_KEY":"${BRAVE_API_KEY}"}}' }
        });

        mockedAxios.post.mockResolvedValueOnce({});
        mockedAxios.post.mockResolvedValueOnce({ data: { count: 1 } });
        mockedAxios.get.mockResolvedValueOnce({
          data: [{ name: 'brave-local', transport: 'stdio', command: 'npx', discoveredTools: ['brave_web_search'] }]
        });

        fireEvent.click(screen.getByRole('button', { name: 'Add' }));

        await waitFor(() => {
          expect(mockedAxios.post).toHaveBeenNthCalledWith(
            1,
            'http://localhost:3000/api/admin/mcp-servers',
            expect.objectContaining({
              name: 'brave-local',
              transport: 'stdio',
              command: 'npx',
              args: ['-y', '@brave/brave-search-mcp-server', '--transport', 'stdio'],
              env: { BRAVE_API_KEY: '${BRAVE_API_KEY}' }
            }),
            expect.any(Object)
          );
        });
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

    describe('Validation', () => {
        it('shows error for invalid server name with special characters', async () => {
            mockedAxios.get.mockResolvedValueOnce({ data: [] });

            render(<McpServersTab />);
            await waitFor(() => expect(screen.queryByRole('progressbar')).not.toBeInTheDocument());

            // Open Dialog
            fireEvent.click(screen.getByText('Add Server'));

            // Enter invalid name
            fireEvent.change(screen.getByLabelText(/Server Name/i), { target: { value: 'invalid name!' } });

            // Check for error message
            expect(screen.getByText(/alphanumeric/i)).toBeInTheDocument();
        });

        it('shows error for invalid URL', async () => {
            mockedAxios.get.mockResolvedValueOnce({ data: [] });

            render(<McpServersTab />);
            await waitFor(() => expect(screen.queryByRole('progressbar')).not.toBeInTheDocument());

            // Open Dialog
            fireEvent.click(screen.getByText('Add Server'));

            // Enter valid name
            fireEvent.change(screen.getByLabelText(/Server Name/i), { target: { value: 'valid-name' } });

            // Enter invalid URL
            fireEvent.change(screen.getByLabelText(/URL/i), { target: { value: 'not-a-url' } });

            // Check for error message
            expect(screen.getByText(/valid http or https URL/i)).toBeInTheDocument();
        });

        it('disables Add button when validation fails', async () => {
            mockedAxios.get.mockResolvedValueOnce({ data: [] });

            render(<McpServersTab />);
            await waitFor(() => expect(screen.queryByRole('progressbar')).not.toBeInTheDocument());

            // Open Dialog
            fireEvent.click(screen.getByText('Add Server'));

            // Enter invalid name
            fireEvent.change(screen.getByLabelText(/Server Name/i), { target: { value: 'invalid!' } });

            // Add button should be disabled
            expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled();
        });

        it('enables Add button when validation passes', async () => {
            mockedAxios.get.mockResolvedValueOnce({ data: [] });

            render(<McpServersTab />);
            await waitFor(() => expect(screen.queryByRole('progressbar')).not.toBeInTheDocument());

            // Open Dialog
            fireEvent.click(screen.getByText('Add Server'));

            // Enter valid name
            fireEvent.change(screen.getByLabelText(/Server Name/i), { target: { value: 'valid-name' } });

            // Enter valid URL
            fireEvent.change(screen.getByLabelText(/URL/i), { target: { value: 'http://valid-url.com' } });

            // Add button should be enabled
            expect(screen.getByRole('button', { name: 'Add' })).not.toBeDisabled();
        });

        it('does not block stdio add when URL is invalid but transport is stdio', async () => {
            mockedAxios.get.mockResolvedValueOnce({ data: [] });

            render(<McpServersTab />);
            await waitFor(() => expect(screen.queryByRole('progressbar')).not.toBeInTheDocument());

            fireEvent.click(screen.getByText('Add Server'));
            fireEvent.change(screen.getByLabelText(/Server Name/i), { target: { value: 'local-stdio' } });

            // Start with invalid URL on HTTP transport
            fireEvent.change(screen.getByLabelText(/URL/i), { target: { value: 'not-a-url' } });
            expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled();

            // Switch to stdio and provide required command
            fireEvent.mouseDown(screen.getByRole('combobox'));
            const listbox = screen.getByRole('listbox');
            fireEvent.click(within(listbox).getByText('Stdio (Backend launches process)'));
            fireEvent.change(await screen.findByLabelText(/Command/i), { target: { value: 'npx' } });

            // URL is irrelevant for stdio; env json is optional
            expect(screen.getByRole('button', { name: 'Add' })).not.toBeDisabled();
        });
    });

});
