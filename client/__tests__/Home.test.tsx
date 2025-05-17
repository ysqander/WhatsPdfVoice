import { render, screen } from '@testing-library/react'
import React from 'react'

test('renders without crashing', () => {
  render(<div>Hello World</div>)
  expect(screen.getByText('Hello World')).toBeInTheDocument()
})
